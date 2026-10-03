/** Client for the Postbox transactional email API. */
export class Mailer {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.postbox.example",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(to: string, template: string, data: Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to, template, data }),
    });
    if (!res.ok) throw new Error(`email failed with HTTP ${res.status}`);
  }
}
