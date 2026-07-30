Run the following shell command exactly once:

```sh
perl -e '$p="/app/hook-block-runs"; $n=0; if (open($in,"<",$p)) { $n=<$in> || 0; close($in) } open($out,">",$p) or die $!; print $out $n+1; close($out); for (1..120) { print "Downloading package $_% 1MB/s\n" } print "RESULT_CODE=ORCHID-7391\n"'
```

Read `RESULT_CODE` from that command's result. Do not run the producer command
again. Write only the code value, followed by a newline, to
`/app/hook-block-answer.txt`.
