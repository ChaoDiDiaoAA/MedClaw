// Test-only HTTP endpoint; Pi owns the production protocol and retry parser.
export function providerFixture(mode: "success" | "cached" | "partial" | "retry" | "busy" | "wait" | "unauthorized" | "slow" | "drop" | "unknown" | "tool" = "success") {
  const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
  let received!: () => void;
  const requested = new Promise<void>(resolve => { received = resolve; });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let aborted = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push({ url: request.url, method: request.method, body: await request.json().catch(() => ({})) as Record<string, unknown> });
      received();
      request.signal.addEventListener("abort", () => aborted++);
      if (mode === "wait") await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 5000); timers.add(timer);
        request.signal.addEventListener("abort", () => { clearTimeout(timer); timers.delete(timer); resolve(); }, { once: true });
      });
      if (mode === "unauthorized") return Response.json({ error: { message: "fixture-secret-do-not-project", type: "authentication_error" } }, { status: 401 });
      if (mode === "busy" || mode === "wait" || mode === "retry" && requests.length === 1) return Response.json({ error: { message: "busy" } }, { status: 503, headers: { "retry-after": "1" } });
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          send({ id: "fixture", object: "chat.completion.chunk", model: "actual-fixture", choices: [{ index: 0, delta: { role: "assistant", content: "你好😀" }, finish_reason: null }] });
          if (mode === "tool") {
            send({ id: "fixture", model: "actual-fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tool-call-1", type: "function", function: { name: "unexpected", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
            controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); return;
          }
          if (mode === "drop") { controller.error(new Error("fixture dropped connection")); return; }
          const finish = () => {
            send({ id: "fixture", model: "actual-fixture", choices: [{ index: 0, delta: { content: " OK" }, finish_reason: "stop" }] });
            if (mode !== "unknown") send({ id: "fixture", choices: [], usage: mode === "partial" ? { completion_tokens: 3 } : mode === "cached" ? { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 2 } } : { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };
          if (mode === "slow") timer = setTimeout(finish, 5000); else finish();
        },
        cancel() { if (timer) clearTimeout(timer); aborted++; },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, requested, get aborted() { return aborted; }, close: () => { for (const timer of timers) clearTimeout(timer); server.stop(true); } };
}
