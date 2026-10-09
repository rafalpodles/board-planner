FROM public.ecr.aws/docker/library/mongo:7.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone curl ca-certificates openssl bash \
 && rm -rf /var/lib/apt/lists/*
COPY common.sh backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
ENTRYPOINT []
CMD ["backup.sh"]
