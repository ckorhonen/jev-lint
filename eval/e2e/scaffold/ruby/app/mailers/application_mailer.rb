# Tiny ActionMailer stand-in: `SomeMailer.method(args).deliver_now` appends to `deliveries`.
class ApplicationMailer
  Mail = Struct.new(:to, :subject, :body) do
    def deliver_now = ApplicationMailer.deliveries << self
  end

  def self.deliveries = (@@deliveries ||= [])

  def self.method_missing(name, *args, **kwargs)
    return super unless public_method_defined?(name)

    new.public_send(name, *args, **kwargs)
  end

  def self.respond_to_missing?(name, include_private = false) = public_method_defined?(name) || super

  def mail(to:, subject:, body: "") = Mail.new(to, subject, body)
end
