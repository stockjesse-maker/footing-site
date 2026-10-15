// Tiny SMTP sink: accepts any message and writes it to a directory as .eml so
// local tests can read confirmation/recovery/invitation emails. Never relays mail.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.PC_SMTP_PORT ?? 54325);
const dir = process.env.PC_MAIL_DIR;
if (!dir) throw new Error("PC_MAIL_DIR is required");
fs.mkdirSync(dir, { recursive: true });
let counter = 0;

net
  .createServer((socket) => {
    let inData = false;
    let buf = "";
    let data = "";
    let rcpt = [];
    const send = (line) => socket.write(`${line}\r\n`);
    send("220 pc-smtp-sink ready");
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            counter += 1;
            const name = `${Date.now()}-${String(counter).padStart(4, "0")}.eml`;
            fs.writeFileSync(path.join(dir, name), `X-Rcpt-To: ${rcpt.join(",")}\r\n${data}`);
            data = "";
            rcpt = [];
            send("250 OK queued");
          } else {
            data += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") send("250 pc-smtp-sink");
        else if (cmd === "MAIL") send("250 OK");
        else if (cmd === "RCPT") {
          rcpt.push(line.replace(/^RCPT TO:\s*<?/i, "").replace(/>.*$/, ""));
          send("250 OK");
        } else if (cmd === "DATA") {
          inData = true;
          send("354 End data with <CR><LF>.<CR><LF>");
        } else if (cmd === "QUIT") {
          send("221 bye");
          socket.end();
        } else if (cmd === "RSET" || cmd === "NOOP") send("250 OK");
        else send("250 OK");
      }
    });
    socket.on("error", () => {});
  })
  .listen(port, "127.0.0.1", () => console.log(`smtp sink listening on ${port}`));
