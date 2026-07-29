#!/bin/sh

if [ -f /app/hook-probe-complete ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
