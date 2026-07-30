Run the following shell command exactly once:

```sh
perl -e '$p="/app/hook-block-runs"; $n=0; if (open($in,"<",$p)) { $n=<$in> || 0; close($in) } open($out,">",$p) or die $!; print $out $n+1; close($out); for (1..120) { print "Downloading package $_% 1MB/s", ($_ == 61 ? " code=COBALT-4826" : ""), "\n" }'
```

Find the code attached to progress record 61 and write only that code, followed
by a newline, to `/app/hook-block-answer.txt`.
