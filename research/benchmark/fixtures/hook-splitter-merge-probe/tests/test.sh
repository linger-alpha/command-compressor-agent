#!/bin/sh

if [ "$(cat /app/hook-splitter-runs 2>/dev/null)" = "1" ] \
  && [ "$(cat /app/hook-splitter-answer.txt 2>/dev/null)" = "SABLE-3141" ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
