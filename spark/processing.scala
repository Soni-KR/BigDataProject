import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.expressions.Window
import org.apache.spark.sql.functions._
try {
  val runPath = sys.env("CYBERFLOW_RUN_PATH")
  val cleanPath = s"hdfs://$runPath/clean"
  spark.conf.set("spark.sql.shuffle.partitions", "8")
  val raw = spark.read.option("header", "true").csv("hdfs:///cyberflow/raw/*.csv")
  val named = raw.toDF(raw.columns.map(_.trim): _*).withColumn("source_file", input_file_name())
  val base = named.withColumn("Label", trim(col("Label")))
  val excluded = Set("Label", "source_file")
  var typed = base
  for (name <- base.columns if !excluded.contains(name)) {
    val dataType = if (name == "Destination Port") "int" else if (name == "Flow Duration") "long" else "double"
    val value = trim(col(s"`$name`"))
    typed = typed.withColumn(name, when(lower(value).isin("infinity", "-infinity", "nan", ""), lit(null)).otherwise(value).cast(dataType))
  }
  val file = col("source_file")
  val withDay = typed.withColumn("day", when(file.contains("Monday"), "2017-07-03").when(file.contains("Tuesday"), "2017-07-04").when(file.contains("Wednesday"), "2017-07-05").when(file.contains("Thursday"), "2017-07-06").when(file.contains("Friday"), "2017-07-07"))
  val names = withDay.columns.map(_.trim.toLowerCase.replaceAll("[^a-z0-9]+", "_").stripPrefix("_").stripSuffix("_"))
  require(names.distinct.length == names.length, "Duplicate columns")
  val cleaned = withDay.toDF(names: _*)
  require(cleaned.filter(col("day").isNull || col("label").isNull || length(col("label")) === 0).count() == 0, "Missing day or label")
  require(cleaned.filter(col("label").rlike("[|\\r\\n]")).count() == 0, "Unsupported label separator")
  cleaned.write.partitionBy("day").parquet(cleanPath)
  val currentRun = spark.read.parquet(cleanPath)
  require(currentRun.inputFiles.nonEmpty && currentRun.inputFiles.forall(_.contains(runPath + "/clean/")), "Cleaned input is outside the current run")
  val saved = currentRun.select("day", "label", "destination_port").cache()
  val total = saved.count()
  require(total > 0 && total == raw.count(), "Processing changed the row count")
  require(saved.filter(col("destination_port").isNull || col("destination_port") < 0 || col("destination_port") > 65535).count() == 0, "Invalid destination port")
  val daily = saved.groupBy("day").agg(count("*").as("total_flows"), sum(when(col("label") === "BENIGN", 1).otherwise(0)).as("benign_flows"), sum(when(col("label") =!= "BENIGN", 1).otherwise(0)).as("attack_flows")).cache()
  val attacks = saved.filter(col("label") =!= "BENIGN").groupBy("day", "label").count().withColumnRenamed("label", "attack_type").withColumnRenamed("count", "flow_count").cache()
  val ports = saved.groupBy("day", "destination_port").agg(count("*").as("total_flows"), sum(when(col("label") =!= "BENIGN", 1).otherwise(0)).as("attack_flows")).cache()
  val rankedPorts = ports.withColumn("rank", row_number().over(Window.partitionBy("day").orderBy(col("total_flows").desc, col("destination_port").asc))).filter(col("rank") <= 50).groupBy("day").agg(collect_list(struct(col("destination_port"), col("total_flows"), col("attack_flows"))).as("ports"))
  val portSnapshot = ports.groupBy("day").agg(count("*").as("total_ports"), sum("total_flows").as("total_flows"), sum("attack_flows").as("attack_flows")).join(rankedPorts, Seq("day")).select(col("day"), to_json(struct(col("total_ports"), col("total_flows"), col("attack_flows"), col("ports"))).as("port_stats"))
  def tsv(df: DataFrame, name: String): Unit = {
    df.coalesce(1).write.option("sep", "|").option("quote", "\u0000").option("header", "false").csv(s"hdfs://$runPath/exports/$name")
  }
  daily.coalesce(1).write.parquet(s"hdfs://$runPath/aggregates/daily")
  attacks.coalesce(1).write.parquet(s"hdfs://$runPath/aggregates/attacks")
  ports.coalesce(1).write.parquet(s"hdfs://$runPath/aggregates/ports")
  tsv(daily.join(portSnapshot, Seq("day")).select(col("day"), col("total_flows"), col("benign_flows"), col("attack_flows"), col("port_stats")), "daily")
  tsv(attacks.select(concat(col("day"), lit("#"), col("attack_type")).as("key"), col("flow_count")), "attacks")
  tsv(ports.select(concat(col("day"), lit("#"), format_string("%05d", col("destination_port"))).as("key"), col("total_flows"), col("attack_flows")), "ports")
  val manifest = daily.join(attacks.groupBy("day").agg(count("*").as("attack_categories")), Seq("day"), "left").join(ports.groupBy("day").agg(count("*").as("destination_ports")), Seq("day"), "left").na.fill(0)
  manifest.coalesce(1).write.json(s"hdfs://$runPath/exports/manifest")
  daily.orderBy("day").show(false)
  println("Processed flows: " + total)
  println("CYBERFLOW_PROCESSING_COMPLETE")
  System.exit(0)
} catch {
  case error: Throwable => error.printStackTrace(); System.exit(1)
}
