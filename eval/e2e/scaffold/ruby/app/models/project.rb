class Project < ApplicationRecord
  belongs_to :user

  validates :name, presence: true
  validates :status, inclusion: { in: %w[active archived] }
end
