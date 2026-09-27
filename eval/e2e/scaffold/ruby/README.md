# shop

A Rails-shaped Ruby app without the full Rails stack: ActiveRecord on SQLite, ActiveJob,
strong parameters, and a small controller base class. Run the specs with `rspec`.

- `app/models/` — ActiveRecord models (schema in `db/schema.rb`)
- `app/controllers/` — controllers; `ApplicationController` provides `params`, `current_user`,
  `render json:`, `head` and `redirect_to` (see the file)
- `app/services/` — service objects (`PaymentGateway` talks to the card processor over HTTP)
- `app/jobs/`, `app/mailers/` — background jobs and email (`OrderMailer.x(...).deliver_now`)
- `config/environment.rb` — boots everything (Zeitwerk autoloads every `app/*` directory)
