export async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** The 16-character prefix used for file and content fingerprints. */
export async function hashText(content: string): Promise<string> {
  return (await sha256Hex(content)).slice(0, 16);
}
