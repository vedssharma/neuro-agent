/** Parses a Server-Sent Events body into the `data:` payload of each event. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === "\r" ? 2 : 1));
        if (line === "") {
          if (data.length > 0) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
        }
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) data.push(buffer.slice(buffer.startsWith("data: ") ? 6 : 5));
    if (data.length > 0) yield data.join("\n");
  } finally {
    reader.releaseLock();
  }
}
