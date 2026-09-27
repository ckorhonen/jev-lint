use relay::config::Config;

#[tokio::main]
async fn main() {
    let config = Config::from_env();
    println!("relay starting on {}", config.listen_addr);
}
