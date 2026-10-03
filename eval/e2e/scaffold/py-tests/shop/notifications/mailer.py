import httpx


class Mailer:
    """Client for the Postbox transactional email API."""

    def __init__(self, api_key: str, base_url: str = "https://api.postbox.example", client: httpx.Client | None = None):
        self._client = client or httpx.Client(base_url=base_url, timeout=10)
        self._headers = {"Authorization": f"Bearer {api_key}"}

    def send(self, to: str, template: str, data: dict) -> None:
        res = self._client.post("/messages", json={"to": to, "template": template, "data": data}, headers=self._headers)
        res.raise_for_status()
