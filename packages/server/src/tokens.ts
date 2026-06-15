// Approximate token counting using a local tokenizer.
//
// NOTE: This is NOT Claude's exact tokenizer. cl100k (OpenAI) is a close-enough
// proxy for *relative* sizing of context blocks, which is all v1 needs. We label
// every count as approximate in the UI. A future version can call the Anthropic
// /v1/messages/count_tokens endpoint for exact figures.

import { getEncoding, type Tiktoken } from "js-tiktoken";

let enc: Tiktoken | null = null;

function encoder(): Tiktoken {
  if (!enc) enc = getEncoding("cl100k_base");
  return enc;
}

export function approxTokens(text: string): number {
  if (!text) return 0;
  try {
    return encoder().encode(text).length;
  } catch {
    // Fallback heuristic: ~4 chars/token.
    return Math.ceil(text.length / 4);
  }
}
