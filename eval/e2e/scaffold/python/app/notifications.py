import smtplib
from email.message import EmailMessage


def send_email(to: str, subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["From"] = "shop@example.com"
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP("localhost") as smtp:
        smtp.send_message(msg)
