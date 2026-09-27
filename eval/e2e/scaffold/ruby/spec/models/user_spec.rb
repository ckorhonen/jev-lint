RSpec.describe User do
  it "requires an email" do
    user = User.new(name: "Ada")
    expect(user).not_to be_valid
    expect(user.errors[:email]).to include("can't be blank")
  end
end
