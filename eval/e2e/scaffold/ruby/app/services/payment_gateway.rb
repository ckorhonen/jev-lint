require "net/http"
require "json"

# Card processor client. `charge` returns the processor's charge id or raises PaymentGateway::Error.
class PaymentGateway
  class Error < StandardError; end

  ENDPOINT = URI("https://api.cardprocessor.example.com/v1/charges")

  def self.charge(amount_cents:, token:)
    res = Net::HTTP.post(ENDPOINT, { amount: amount_cents, source: token }.to_json,
                         "Content-Type" => "application/json",
                         "Authorization" => "Bearer #{ENV.fetch('CARD_PROCESSOR_KEY', '')}")
    raise Error, "charge failed (#{res.code})" unless res.is_a?(Net::HTTPSuccess)

    JSON.parse(res.body).fetch("id")
  end
end
