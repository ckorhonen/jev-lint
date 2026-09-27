ActiveRecord::Schema.define do
  create_table :users, force: true do |t|
    t.string :email, null: false
    t.string :name, null: false
    t.boolean :admin, null: false, default: false
    t.integer :credits, null: false, default: 0
    t.timestamps
  end

  create_table :projects, force: true do |t|
    t.references :user, null: false
    t.string :name, null: false
    t.text :description
    t.string :status, null: false, default: "active"
    t.boolean :featured, null: false, default: false
    t.timestamps
  end

  create_table :products, force: true do |t|
    t.string :name, null: false
    t.integer :price_cents, null: false
    t.integer :stock, null: false, default: 0
    t.timestamps
  end

  create_table :orders, force: true do |t|
    t.references :user, null: false
    t.string :status, null: false, default: "pending"
    t.integer :total_cents, null: false, default: 0
    t.string :charge_id
    t.timestamps
  end

  create_table :line_items, force: true do |t|
    t.references :order, null: false
    t.references :product, null: false
    t.integer :quantity, null: false
    t.integer :unit_price_cents, null: false
  end
end
