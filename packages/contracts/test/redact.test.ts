import { describe, expect, it } from "vitest";
import { REDACTED, redactAndCount } from "../src/redact";

/** Tokens are assembled at runtime so this file holds no token shapes of its own. */
const rep = (s: string, n: number) => s.repeat(n);
const hide = (text: string, known: string[] = []) => redactAndCount(text, { known }).text;

describe("redactAndCount: token shapes", () => {
  const shapes: [string, string][] = [
    ["GitHub classic", `ghp_${rep("A1b2C3d4", 5)}`],
    ["GitHub OAuth", `gho_${rep("Z9y8X7w6", 5)}`],
    ["GitHub fine-grained", `github_pat_${rep("11AbC0dEf", 6)}`],
    ["OpenAI", `sk-proj-${rep("Xy9Zq8Wv", 6)}`],
    ["OpenAI legacy", `sk-${rep("aB3dE5", 8)}`],
    ["Anthropic", `sk-ant-api03-${rep("Qa1Ws2Ed", 6)}`],
    ["AWS access key", `AKIA${rep("Z7Q2", 4)}`],
    ["Slack", `xoxb-${rep("1234", 3)}-${rep("AbCd", 6)}`],
    ["JWT", `eyJ${rep("hbGciOiJ", 3)}.eyJ${rep("zdWIiOiJ", 3)}.${rep("dozjgNry", 4)}`],
    ["Stripe", `sk_live_${rep("4eC39HqL", 3)}`],
    ["GitLab", `glpat-${rep("x1Y2z3", 4)}`],
    ["npm", `npm_${rep("Ab12", 9)}`],
    ["Google", `AIza${rep("Sy0aB-cD_e", 4)}`],
    ["Agent Rishi MCP", `cdm_${rep("q1W2e3R4t5", 4)}`],
    ["Agent Rishi remote access", `cds_${rep("Mn8_Bv7-Cx", 4)}`],
  ];

  it.each(shapes)("hides a %s token in a sentence", (_name, token) => {
    const r = redactAndCount(`It printed ${token} and stopped.`);
    expect(r.text).toBe(`It printed ${REDACTED} and stopped.`);
    expect(r.count).toBe(1);
  });

  it("hides bearer tokens and Authorization headers", () => {
    const token = rep("b3ar3rT0k", 3);
    expect(hide(`curl -H "Authorization: Bearer ${token}" https://api.example.com`)).toBe(
      `curl -H "Authorization: Bearer ${REDACTED}" https://api.example.com`,
    );
    expect(hide(`{"authorization": "token ${token}"}`)).toBe(
      `{"authorization": "token ${REDACTED}"}`,
    );
    expect(hide(`curl --oauth2-bearer x -H 'Bearer ${token}'`)).toBe(
      `curl --oauth2-bearer x -H 'Bearer ${REDACTED}'`,
    );
  });

  it("hides credentials in URLs and private key blocks", () => {
    expect(hide("git clone https://bot:pa55w0rd@github.com/acme/app.git")).toBe(
      `git clone https://${REDACTED}@github.com/acme/app.git`,
    );
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${rep("b3BlbnNzaC1rZXk", 4)}\n-----END OPENSSH PRIVATE KEY-----`;
    expect(hide(`Key:\n${pem}\nDone`)).toBe(`Key:\n${REDACTED}\nDone`);
  });

  it("hides exact known values, such as the install token", () => {
    const install = rep("f00d", 16);
    const r = redactAndCount(`curl -H "x-token: ${install}" && echo ${install}`, {
      known: [install, "short"],
    });
    expect(r.text).toBe(`curl -H "x-token: ${REDACTED}" && echo ${REDACTED}`);
    expect(r.count).toBe(2);
    // A short known value is ignored, so it can't blank out ordinary words.
    expect(hide("a short note", ["short"])).toBe("a short note");
  });
});

describe("redactAndCount: KEY=value", () => {
  it("hides values of secret-named keys in env files, shells, YAML and JSON", () => {
    const lines = [
      ["export GITHUB_TOKEN=abcdef", `export GITHUB_TOKEN=${REDACTED}`],
      ["DB_PASSWORD=correct-horse", `DB_PASSWORD=${REDACTED}`],
      ["OPENAI_API_KEY=whatever", `OPENAI_API_KEY=${REDACTED}`],
      ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG", `AWS_SECRET_ACCESS_KEY=${REDACTED}`],
      ["NEXTAUTH_SECRET='a b c'", `NEXTAUTH_SECRET=${REDACTED}`],
      ["password: 'hunter'", `password: ${REDACTED}`],
      ['{"api_key": "abc", "name": "app"}', `{"api_key": ${REDACTED}, "name": "app"}`],
      ["clientSecret = hunter22", `clientSecret = ${REDACTED}`],
      ["//registry.npmjs.org/:_authToken=abc", `//registry.npmjs.org/:_authToken=${REDACTED}`],
      [
        "https://x.dev/cb?access_token=a1b2c3d4&state=ok",
        `https://x.dev/cb?access_token=${REDACTED}&state=ok`,
      ],
      [
        "deploy --token s3cr3t --password=hunter",
        `deploy --token ${REDACTED} --password=${REDACTED}`,
      ],
    ];
    for (const [input, output] of lines) expect(hide(input as string), input).toBe(output);
  });

  it("hides glued and short secret names: PGPASSWORD, MYSQL_PWD, *_AUTHTOKEN, AUTH", () => {
    const lines = [
      ["PGPASSWORD=hunter2-correct psql -h db", `PGPASSWORD=${REDACTED} psql -h db`],
      ["MYSQL_PWD=hunter22 mysql", `MYSQL_PWD=${REDACTED} mysql`],
      ["NGROK_AUTHTOKEN=2abcDEF34ghi ngrok http 80", `NGROK_AUTHTOKEN=${REDACTED} ngrok http 80`],
      ["ACCESSTOKEN=abc123def", `ACCESSTOKEN=${REDACTED}`],
      ["AUTH=abc123def", `AUTH=${REDACTED}`],
      ["CREDENTIALS=abc123def", `CREDENTIALS=${REDACTED}`],
      ["clientsecret: 'abc'", `clientsecret: ${REDACTED}`],
      ["Server=db;Uid=app;Pwd=hunter22;", `Server=db;Uid=app;Pwd=${REDACTED};`],
    ];
    for (const [input, output] of lines) expect(hide(input as string), input).toBe(output);
  });

  it("hides options with a prefix before the secret word (--db-password=, --api-token=)", () => {
    const lines = [
      ["psql --db-password=hunter2 -h db", `psql --db-password=${REDACTED} -h db`],
      [
        "wp core install --admin_password=hunter22 --url=x.dev",
        `wp core install --admin_password=${REDACTED} --url=x.dev`,
      ],
      ["--api-token=abc123def", `--api-token=${REDACTED}`],
      ["gh-sync --github-token=abc123def", `gh-sync --github-token=${REDACTED}`],
      ["npm-cli --registry-token=abc123def", `npm-cli --registry-token=${REDACTED}`],
      ["tool -db-password=hunter22", `tool -db-password=${REDACTED}`],
      ["my-db-password=hunter22", `my-db-password=${REDACTED}`],
      ["Use the token abcdefgh1234 for the API", `Use the token ${REDACTED} for the API`],
    ];
    for (const [input, output] of lines) expect(hide(input as string), input).toBe(output);
  });

  it("counts each hidden value once, and a second pass changes nothing", () => {
    const text = `GITHUB_TOKEN=ghp_${rep("A1b2C3d4", 5)} API_KEY=abc123`;
    const once = redactAndCount(text);
    expect(once.text).toBe(`GITHUB_TOKEN=${REDACTED} API_KEY=${REDACTED}`);
    expect(once.count).toBe(2);
    expect(redactAndCount(once.text)).toEqual({ text: once.text, count: 0 });
  });

  it("leaves references, placeholders and code that only names a secret", () => {
    for (const plain of [
      "GITHUB_TOKEN=$GITHUB_TOKEN gh pr list",
      // A GitHub Actions expression, not a template placeholder.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text is the test input
      "OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
      "set API_KEY=%API_KEY%",
      "API_KEY=<your key>",
      "PASSWORD=****",
      "token: string;",
      "const password = getPassword();",
      "headers={token=getToken()}",
      "apiKey: process.env.API_KEY,",
      "if (token === undefined) return;",
      "docker login --password-stdin",
      "MAX_TOKENS=4096",
      "TOKENIZERS_PARALLELISM=false",
      "TOKEN_URL=https://auth.example.com/token",
      "AWS_ACCESS_KEY_ID=fromenv",
      "secrets: inherit",
      "PWD=/home/dev/app OLDPWD=/home/dev",
      "PGPASSWORD_FILE=/run/secrets/pg",
      "NEXTAUTH_URL=http://localhost:3000 AUTH_MODE=strict",
      "auth: required",
      'fetch(url, { credentials: "include" })',
      "BYPASS_CACHE=1",
      "MAX_TOKEN=4096 MIN_PASSWORD=8",
      "--token-file=/run/secrets/token --password-stdin",
    ]) {
      expect(redactAndCount(plain), plain).toEqual({ text: plain, count: 0 });
    }
  });
});

describe("redactAndCount: no false positives", () => {
  it("leaves ordinary words, paths, hashes and numbers alone", () => {
    for (const plain of [
      "Add basic validation to the login form",
      "The bearer of bad news is the token refresh",
      "Authorization: required for every endpoint",
      "Password: use at least eight characters",
      "Edit src/theme/tokens.ts and apps/server/src/token.ts",
      "commit 3f786850e387550fdab836ed7e6dc881de23001b",
      "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "Merged 9c9eaaba (chore(release): 0.7.2)",
      "mkdir -p apps/web && git push -u origin main",
      "Fix the task-sk-learn-pipeline-import-error branch",
      "Read the AKIA prefix docs and ghp_ tokens in the guide",
      "Cost: $1.23 · 48k tokens · 2 turns",
      "Note: this is fine. Key: value",
    ]) {
      expect(redactAndCount(plain), plain).toEqual({ text: plain, count: 0 });
    }
  });

  it("masks long opaque strings only when asked (the pixel scene)", () => {
    const sha = "3f786850e387550fdab836ed7e6dc881de23001b";
    expect(redactAndCount(`sha ${sha}`).text).toBe(`sha ${sha}`);
    expect(redactAndCount(`sha ${sha}`, { opaque: true, mask: "***" }).text).toBe("sha ***");
  });
});

describe("redactAndCount: large input", () => {
  // The text is an agent's and the export runs on the server's event loop: every rule must stay
  // linear. Each of these took seconds to minutes when a rule re-read a run from each character;
  // all of them together take a few milliseconds now, so the bound below is very loose.
  const size = 200_000;
  const inputs: [string, string][] = [
    ["a kebab-case run", "a-".repeat(size / 2)],
    ["a base64url blob", Array.from({ length: size }, (_, i) => "Ab9_-"[i % 5]).join("")],
    ["a run of letters", "abcdefgh".repeat(size / 8)],
    ["colons", "a:".repeat(size / 2)],
    ["scheme-like text", "ab+".repeat(size / 3)],
    ["sk- prefixes", "sk-".repeat(size / 3)],
    ["JWT-like starts", "-eyJabcdefghij".repeat(size / 14)],
    ["unfinished private keys", "-----BEGIN RSA PRIVATE KEY-----\n".repeat(size / 32)],
    ["secret keys without values", "token: token: ".repeat(size / 14)],
    ["double dashes", "ab--".repeat(size / 4)],
    ["option-like dashes", "--a".repeat(size / 3)],
  ];

  it.each(inputs)("redacts %s of 200 KB in well under a second", (_name, text) => {
    const started = performance.now();
    redactAndCount(text, { opaque: true, known: ["f00d".repeat(16)] });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
