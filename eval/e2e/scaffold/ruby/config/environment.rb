require "active_record"
require "active_job"
require "action_controller/metal/strong_parameters"
require "zeitwerk"

ROOT = File.expand_path("..", __dir__)

ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ENV.fetch("DATABASE_PATH", ":memory:"))
ActiveRecord::Schema.verbose = false
load File.join(ROOT, "db/schema.rb")

ActiveJob::Base.queue_adapter = :test
ActiveJob::Base.logger = Logger.new(nil)

loader = Zeitwerk::Loader.new
Dir[File.join(ROOT, "app/*")].select { |d| File.directory?(d) }.each { |dir| loader.push_dir(dir) }
loader.setup
loader.eager_load
