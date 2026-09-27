# Minimal stand-in for ActionController::Base: enough to write and spec controller actions.
#   controller = ProjectsController.new(params: { id: 1 }, current_user: user)
#   controller.update
#   controller.response  # => { status: 200, json: {...} } or { status: 302, location: "..." }
class ApplicationController
  attr_reader :params, :current_user, :response

  def initialize(params: {}, current_user: nil)
    @params = ActionController::Parameters.new(params)
    @current_user = current_user
    @response = nil
  end

  def render(json:, status: :ok)
    @response = { status: Rack::Utils.status_code(status), json: json }
  end

  def head(status)
    @response = { status: Rack::Utils.status_code(status), json: nil }
  end

  def redirect_to(location)
    @response = { status: 302, location: location }
  end
end
