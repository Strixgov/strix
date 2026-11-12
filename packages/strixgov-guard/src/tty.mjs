/**
 * Terminal I/O for approvals. A passphrase and a confirmation are only ever
 * read from a real TTY: never from an argument, an environment variable or a
 * pipe, because those are readable by (or scriptable from) the agent.
 */
export function ttyIo(stdin = process.stdin, stdout = process.stdout) {
  const isTty = stdin.isTTY === true && stdout.isTTY === true;

  function readLine(prompt, { mute }) {
    return new Promise((resolve, reject) => {
      stdout.write(prompt);
      let buf = "";
      const wasRaw = stdin.isRaw;
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const done = (fn, v) => {
        stdin.removeListener("data", onData);
        stdin.setRawMode?.(wasRaw === true);
        stdin.pause();
        stdout.write("\n");
        fn(v);
      };
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") return done(resolve, buf);
          if (ch === "\u0003") return done(reject, new Error("cancelled"));
          if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
          buf += ch;
          if (!mute) stdout.write(ch);
        }
      };
      stdin.on("data", onData);
    });
  }

  return {
    isTty,
    secret: (q) => readLine(q, { mute: true }),
    confirm: async (q) => (await readLine(q, { mute: false })).trim().toLowerCase() === "yes",
    print: (line) => stdout.write(line + "\n"),
  };
}
