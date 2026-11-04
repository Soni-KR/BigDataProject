// Importer les classes et fonctions nécessaires de Spark
import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.expressions.Window
import org.apache.spark.sql.functions._

try {
  // Récupérer le chemin HDFS de l'exécution actuelle
  val runPath = sys.env("CYBERFLOW_RUN_PATH")
  val cleanPath = s"hdfs://$runPath/clean"

  // Configurer le nombre de partitions utilisées lors des opérations Shuffle
  spark.conf.set("spark.sql.shuffle.partitions", "8")

  // Lire tous les fichiers CSV bruts depuis HDFS
  val raw = spark.read.option("header", "true").csv("hdfs:///cyberflow/raw/*.csv")

  // Nettoyer les noms des colonnes et ajouter le nom du fichier source
  val named = raw.toDF(raw.columns.map(_.trim): _*)
    .withColumn("source_file", input_file_name())

  // Supprimer les espaces autour des étiquettes (Label)
  val base = named.withColumn("Label", trim(col("Label")))
  val excluded = Set("Label", "source_file")
  var typed = base

  // Convertir les colonnes selon leur type de données
  for (name <- base.columns if !excluded.contains(name)) {
    val dataType =
      if (name == "Destination Port") "int"
      else if (name == "Flow Duration") "long"
      else "double"

    val value = trim(col(s"`$name`"))

    // Remplacer les valeurs non numériques ou infinies par NULL
    typed = typed.withColumn(
      name,
      when(lower(value).isin("infinity", "-infinity", "nan", ""), lit(null))
        .otherwise(value).cast(dataType)
    )
  }

  // Déduire la date de chaque flux à partir du nom du fichier source
  val file = col("source_file")
  val withDay = typed.withColumn(
    "day",
    when(file.contains("Monday"), "2017-07-03")
      .when(file.contains("Tuesday"), "2017-07-04")
      .when(file.contains("Wednesday"), "2017-07-05")
      .when(file.contains("Thursday"), "2017-07-06")
      .when(file.contains("Friday"), "2017-07-07")
  )

  // Normaliser les noms des colonnes : minuscules et underscores
  val names = withDay.columns.map(
    _.trim.toLowerCase.replaceAll("[^a-z0-9]+", "_").stripPrefix("_").stripSuffix("_")
  )

  // Vérifier qu'aucun nom de colonne n'est dupliqué
  require(names.distinct.length == names.length, "Duplicate columns")
  val cleaned = withDay.toDF(names: _*)

  // Vérifier la présence des dates et des étiquettes
  require(
    cleaned.filter(col("day").isNull || col("label").isNull || length(col("label")) === 0).count() == 0,
    "Missing day or label"
  )

  // Vérifier que les étiquettes ne contiennent pas le séparateur réservé |
  require(
    cleaned.filter(col("label").rlike("[|\\r\\n]")).count() == 0,
    "Unsupported label separator"
  )

  // Enregistrer les données nettoyées au format Parquet, partitionnées par jour
  cleaned.write.partitionBy("day").parquet(cleanPath)

  // Relire les données nettoyées depuis HDFS
  val currentRun = spark.read.parquet(cleanPath)

  // Vérifier que les fichiers lus appartiennent bien à l'exécution actuelle
  require(
    currentRun.inputFiles.nonEmpty && currentRun.inputFiles.forall(_.contains(runPath + "/clean/")),
    "Cleaned input is outside the current run"
  )

  // Sélectionner les colonnes utiles et mettre les données en cache
  val saved = currentRun.select("day", "label", "destination_port").cache()
  val total = saved.count()

  // Vérifier que le traitement n'a supprimé aucune ligne
  require(total > 0 && total == raw.count(), "Processing changed the row count")

  // Vérifier que les ports de destination sont valides (entre 0 et 65535)
  require(
    saved.filter(
      col("destination_port").isNull ||
      col("destination_port") < 0 ||
      col("destination_port") > 65535
    ).count() == 0,
    "Invalid destination port"
  )

  // Calculer les statistiques quotidiennes : total, flux bénins et attaques
  val daily = saved.groupBy("day").agg(
    count("*").as("total_flows"),
    sum(when(col("label") === "BENIGN", 1).otherwise(0)).as("benign_flows"),
    sum(when(col("label") =!= "BENIGN", 1).otherwise(0)).as("attack_flows")
  ).cache()

  // Calculer le nombre de flux pour chaque type d'attaque et chaque jour
  val attacks = saved.filter(col("label") =!= "BENIGN")
    .groupBy("day", "label")
    .count()
    .withColumnRenamed("label", "attack_type")
    .withColumnRenamed("count", "flow_count")
    .cache()

  // Calculer les statistiques par port et par jour
  val ports = saved.groupBy("day", "destination_port").agg(
    count("*").as("total_flows"),
    sum(when(col("label") =!= "BENIGN", 1).otherwise(0)).as("attack_flows")
  ).cache()

  // Classer les ports selon le nombre total de flux pour chaque jour
  // En cas d'égalité, le port ayant le plus petit numéro est prioritaire
  val rankedPorts = ports
    .withColumn(
      "rank",
      row_number().over(
        Window.partitionBy("day")
          .orderBy(col("total_flows").desc, col("destination_port").asc)
      )
    )
    .filter(col("rank") <= 50)

    // Regrouper les 50 ports les plus utilisés par jour
    .groupBy("day")
    .agg(
      collect_list(
        struct(col("destination_port"), col("total_flows"), col("attack_flows"))
      ).as("ports")
    )

  // Créer un résumé global des statistiques des ports pour chaque jour et le stocker
  // Pour que l’API puisse lire directement les statistiques pré-calculées sans scanner toute la table détaillée des ports à chaque requête
  val portSnapshot = ports.groupBy("day").agg(
    count("*").as("total_ports"),
    sum("total_flows").as("total_flows"),
    sum("attack_flows").as("attack_flows")
  ).join(rankedPorts, Seq("day"))
    .select(
      col("day"),
      to_json(
        struct(
          col("total_ports"),
          col("total_flows"),
          col("attack_flows"),
          col("ports")
        )
      ).as("port_stats")
    )

  // Fonction pour exporter un DataFrame au format CSV avec | comme séparateur
  def tsv(df: DataFrame, name: String): Unit = {
    df.coalesce(1)
      .write
      .option("sep", "|")
      .option("quote", "\u0000")
      .option("header", "false")
      .csv(s"hdfs://$runPath/exports/$name")
  }

  // Enregistrer les agrégations au format Parquet
  daily.coalesce(1).write.parquet(s"hdfs://$runPath/aggregates/daily")
  attacks.coalesce(1).write.parquet(s"hdfs://$runPath/aggregates/attacks")
  ports.coalesce(1).write.parquet(s"hdfs://$runPath/aggregates/ports")

  // Exporter les statistiques quotidiennes avec le résumé des ports
  tsv(
    daily.join(portSnapshot, Seq("day"))
      .select(
        col("day"),
        col("total_flows"),
        col("benign_flows"),
        col("attack_flows"),
        col("port_stats")
      ),
    "daily"
  )

  // Exporter les statistiques par type d'attaque
  // La clé est construite sous la forme date#type_attaque
  tsv(
    attacks.select(
      concat(col("day"), lit("#"), col("attack_type")).as("key"),
      col("flow_count")
    ),
    "attacks"
  )

  // Exporter les statistiques par port
  // La clé est construite sous la forme date#numéro_du_port
  tsv(
    ports.select(
      concat(col("day"), lit("#"), format_string("%05d", col("destination_port"))).as("key"),
      col("total_flows"),
      col("attack_flows")
    ),
    "ports"
  )

  // Créer un manifeste récapitulatif des statistiques par jour
  val manifest = daily
    .join(
      attacks.groupBy("day").agg(count("*").as("attack_categories")),
      Seq("day"),
      "left"
    )
    .join(
      ports.groupBy("day").agg(count("*").as("destination_ports")),
      Seq("day"),
      "left"
    )
    .na.fill(0)

  // Enregistrer le manifeste au format JSON dans HDFS 
  // coalesce(1) produit un seul fichier de sortie par export
  manifest.coalesce(1).write.json(s"hdfs://$runPath/exports/manifest")

  // Afficher les statistiques quotidiennes dans la console
  daily.orderBy("day").show(false)

  // Afficher le nombre total de flux traités
  println("Processed flows: " + total)

  // Terminer normalement le programme
  System.exit(0)

} catch {
  // Afficher les détails de toute erreur et terminer avec un code d'échec
  case error: Throwable =>
    error.printStackTrace()
    System.exit(1)
}
