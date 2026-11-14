// Real, small hosted inference. Configuration is loaded by npm's --env-file option.
const missing = ["NVIDIA_API_KEY", "NVIDIA_MODEL"].filter(name => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Missing configuration: ${missing.join(", ")}`);
  process.exitCode = 2;
} else {
  const started = performance.now();
  try {
    const url = new URL((process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "") + "/chat/completions");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("configuration");
    const model = process.env.NVIDIA_MODEL;
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, max_tokens: 256,
        ...(model.startsWith("openai/gpt-oss-") ? { reasoning_effort: "low" } : {}),
        messages: [{ role: "user", content: 'Reply with only this JSON object: {"ok":true}' }] }),
    });
    if (!response.ok) {
      console.error(`NVIDIA inference failed: HTTP ${response.status}`); process.exitCode = 1;
    } else {
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("invalid");
      console.log(`NVIDIA real POST inference succeeded (${Math.round(performance.now() - started)} ms).`);
    }
  } catch {
    console.error("NVIDIA inference unavailable, invalid, or timed out."); process.exitCode = 1;
  }
}
