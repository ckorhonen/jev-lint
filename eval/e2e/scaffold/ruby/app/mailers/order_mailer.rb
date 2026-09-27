class OrderMailer < ApplicationMailer
  def confirmation(order)
    mail(to: order.user.email, subject: "Order ##{order.id} confirmed", body: "Total: #{order.total_cents / 100.0}")
  end
end
