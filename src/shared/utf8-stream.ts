import { StringDecoder } from "node:string_decoder";
import type { IncomingMessage } from "node:http";

export function createUtf8Decoder(): StringDecoder {
  return new StringDecoder("utf8");
}

export function decodeUtf8Chunk(decoder: StringDecoder, chunk: Buffer): string {
  return decoder.write(chunk);
}

export function finishUtf8Decoder(decoder: StringDecoder): string {
  return decoder.end();
}

export function concatUtf8(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf-8");
}

export function readIncomingBodyUtf8(req: IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(concatUtf8(chunks)));
    req.on("error", reject);
  });
}
