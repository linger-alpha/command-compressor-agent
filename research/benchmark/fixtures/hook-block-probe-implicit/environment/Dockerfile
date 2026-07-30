FROM ubuntu:24.04

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends perl \
    && rm -rf /var/lib/apt/lists/*
