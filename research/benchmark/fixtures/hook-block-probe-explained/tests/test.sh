#!/bin/sh

if [ "$(cat /app/hook-block-runs 2>/dev/null)" = "1" ] \
  && [ "$(cat /app/hook-block-answer.txt 2>/dev/null)" = "COBALT-4826" ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
