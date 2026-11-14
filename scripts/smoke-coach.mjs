// Real, small inference. Use the same production Next.js env precedence as npm run smoke.
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const deployment = process.env.NVIDIA_DEPLOYMENT?.trim() || "hosted";
const isBrev = deployment === "brev";
const missing = ["NVIDIA_API_KEY", "NVIDIA_MODEL", ...(isBrev ? ["NVIDIA_BASE_URL"] : [])].filter(name => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Missing configuration: ${missing.join(", ")}`);
  process.exitCode = 2;
} else {
  const started = performance.now();
  try {
    if (deployment !== "hosted" && !isBrev) throw new Error("configuration");
    const url = new URL((process.env.NVIDIA_BASE_URL?.trim() || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "") + "/chat/completions");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("configuration");
    const model = process.env.NVIDIA_MODEL.trim();
    if (isBrev && (model !== "nvidia/NVIDIA-Nemotron-Nano-9B-v2" || url.hostname === "integrate.api.nvidia.com")) throw new Error("configuration");
    const schema = isBrev || model === "nvidia/nemotron-3.5-super-vl-120b-a12b" ? { response_format: { type: "json_schema", json_schema: { name: "incidentlab_probe", strict: true, schema: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false } } } } : {};
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, max_tokens: 256, temperature: 0, ...schema,
        ...(!isBrev && model === "nvidia/nemotron-3.5-super-vl-120b-a12b" ? { reasoning_effort: "none" } : {}),
        ...(model.startsWith("openai/gpt-oss-") ? { reasoning_effort: "low" } : {}),
        messages: [...(isBrev ? [{ role: "system", content: "/no_think\nReturn exactly one bare JSON object. Do not use Markdown, backticks, code fences, explanations, or text outside the object." }] : []), { role: "user", content: 'Reply with exactly this bare JSON object, without Markdown or code fences: {"ok":true}' }] }),
    });
    if (!response.ok) {
      console.error(`NVIDIA inference failed: HTTP ${response.status}`); process.exitCode = 1;
    } else {
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("invalid");
      const parsed = JSON.parse(content);
      if (!parsed || parsed.ok !== true || Object.keys(parsed).length !== 1) throw new Error("invalid");
      console.log(`${isBrev ? "Self-hosted NVIDIA model on Brev" : "NVIDIA hosted API"} real POST inference succeeded (${Math.round(performance.now() - started)} ms).`);
    }
  } catch {
    console.error("NVIDIA inference unavailable, invalid, or timed out."); process.exitCode = 1;
  }
}
