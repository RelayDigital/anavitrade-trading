import http from "http";

function httpPost(path, data, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const opts = {
      hostname: "127.0.0.1",
      port: 8787,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: body.slice(0, 2000) }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("TIMEOUT")); });
    req.write(body);
    req.end();
  });
}

function httpGet(path, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port: 8787,
      path,
      method: "GET",
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: body.slice(0, 2000) }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("TIMEOUT")); });
    req.end();
  });
}

async function main() {
  const TS = Date.now();
  const email = `apidiag+${TS}@test.test`;

  console.log("1. Health check (direct to workerd)...");
  try {
    const health = await httpGet("/api/health");
    console.log(`   Status: ${health.status}, Body: ${health.body}`);
  } catch (e) {
    console.log(`   FAILED: ${e.message}`);
  }

  console.log("\n2. Registration API...");
  try {
    const reg = await httpPost(
      "/api/trpc/auth.register",
      { "0": { name: "API Diag", email, password: "DiagPass123!" } },
      30000
    );
    console.log(`   Status: ${reg.status}`);
    console.log(`   Headers: ${JSON.stringify(reg.headers)}`);
    console.log(`   Body: ${reg.body}`);
  } catch (e) {
    console.log(`   FAILED: ${e.message}`);
  }

  console.log("\n3. Login API...");
  try {
    const login = await httpPost(
      "/api/trpc/auth.login",
      { "0": { email, password: "DiagPass123!" } },
      15000
    );
    console.log(`   Status: ${login.status}`);
    console.log(`   Set-Cookie: ${login.headers["set-cookie"]}`);
    console.log(`   Body: ${login.body?.slice(0, 300)}`);
  } catch (e) {
    console.log(`   FAILED: ${e.message}`);
  }
}

main().catch(console.error);
