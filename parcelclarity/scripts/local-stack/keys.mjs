// Prints HS256 JWTs (anon, service_role) signed with the local JWT secret.
import { createHmac } from "node:crypto";

const secret = process.env.PC_JWT_SECRET;
if (!secret) throw new Error("PC_JWT_SECRET is required");
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function sign(role) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: "parcelclarity-local", role, iat: 1700000000, exp: 4102444800 });
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const which = process.argv[2];
console.log(sign(which === "service" ? "service_role" : "anon"));
