\# CyberFlow — Data Ingestion Module



\## Objective



Ingest the CIC-IDS2017 cybersecurity dataset into Hadoop HDFS for distributed processing using Apache Spark.



\## Dataset



\- Source: https://www.kaggle.com/datasets/chethuhn/network-intrusion-dataset

\- Format: CSV

\- Files: 8

\- Total size: approximately 885 MB

\- Contains network-flow features and attack labels.

\- The inspected CSV has 79 columns, including headers with leading spaces.



\## Infrastructure



\- Hadoop cluster using Docker

\- 1 NameNode (`hadoop-master`)

\- 2 DataNodes (`hadoop-slave1`, `hadoop-slave2`)

\- HDFS replication factor: 2



\## Ingestion



1\. Download the eight CSV files.

2\. Start the Hadoop cluster.

3\. Copy the dataset into the master container:



```powershell

docker exec hadoop-master mkdir -p /data/cicids

docker cp "PATH\_TO\_DATASET\\." hadoop-master:/data/cicids/

```



4\. Copy and run the ingestion script:



```powershell

docker cp .\\ingestion\\ingest\_hdfs.sh hadoop-master:/root/ingest\_hdfs.sh

docker exec hadoop-master bash /root/ingest\_hdfs.sh

```



The script creates `/cyberflow/raw/` in HDFS, uploads missing CSV files, and verifies HDFS storage.



\## Verified Results



\- 8 CSV files successfully uploaded.

\- 11 HDFS blocks.

\- Replication factor: 2.

\- 2 active DataNodes.

\- HDFS `fsck` status: HEALTHY.

\- No missing or corrupt blocks.



\## Handoff to Spark Team



\*\*HDFS input path:\*\*



`hdfs:///cyberflow/raw/\*.csv`



Member 2 can read the files using Apache Spark:



```scala

val df = spark.read

&#x20; .option("header", "true")

&#x20; .csv("hdfs:///cyberflow/raw/\*.csv")

```



The Spark module will handle schema normalization, data cleaning, and security analytics.



\*\*Note:\*\* The raw CSV files are not included in GitHub. Team members must download them from the dataset source or use the shared Hadoop cluster.

