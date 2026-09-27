require_relative "../config/environment"

RSpec.configure do |config|
  config.around do |example|
    ActiveRecord::Base.transaction do
      example.run
      raise ActiveRecord::Rollback
    end
  end
  config.before { ApplicationMailer.deliveries.clear }
end
