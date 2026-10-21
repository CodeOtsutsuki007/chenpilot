#![cfg(test)]

//! Contract-balance conservation after every vault transition.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

fn setup(env: &Env) -> (Address, Address, CoreVaultContractClient) {
    let admin = Address::generate(env);
    let vault_token = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let unified_auth = Address::generate(env);
    let contract_id = env.register_contract(None, CoreVaultContract);
    let client = CoreVaultContractClient::new(env, &contract_id);
    client.init(&admin, &vault_token, &unified_auth);
    (admin, vault_token, client)
}

fn token_bal(env: &Env, token: &Address, account: &Address) -> i128 {
    TokenClient::new(env, token).balance(account)
}

/// Native XLM is never moved by core_vault. Snapshot a dummy unused asset so
/// drift on a non-vault token would fail the test.
fn unused_native_stand_in(env: &Env, admin: &Address) -> Address {
    env.register_stellar_asset_contract_v2(admin.clone()).address()
}

#[test]
fn balances_conserved_across_deposit_withdrawal_pause_and_emergency() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, token, client) = setup(&env);
    let native = unused_native_stand_in(&env, &admin);
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&user, &5_000);

    let native_before = token_bal(&env, &native, &client.address);
    assert_eq!(token_bal(&env, &token, &client.address), 0);

    client.deposit(&user, &1_000);
    assert_eq!(token_bal(&env, &token, &client.address), 1_000);
    assert_eq!(client.get_deposit(&user), Some(1_000));
    assert_eq!(token_bal(&env, &native, &client.address), native_before);

    client.pause();
    assert_eq!(token_bal(&env, &token, &client.address), 1_000);
    client.withdrawal(&user, &200);
    assert_eq!(token_bal(&env, &token, &client.address), 800);
    assert_eq!(client.get_deposit(&user), Some(800));
    client.unpause();

    client.set_backend_status(&false);
    client.force_exit_request(&user);
    assert_eq!(token_bal(&env, &token, &client.address), 800);
    client.recovery(&user);
    assert_eq!(token_bal(&env, &token, &client.address), 800);
    assert_eq!(client.get_deposit(&user), Some(800));

    env.ledger().set(LedgerInfo {
        timestamp: env.ledger().timestamp() + FORCE_EXIT_DELAY + 1,
        ..env.ledger().get()
    });
    client.force_exit_request(&user);
    env.ledger().set(LedgerInfo {
        timestamp: env.ledger().timestamp() + FORCE_EXIT_DELAY + 1,
        ..env.ledger().get()
    });
    client.force_exit_complete(&user);
    assert_eq!(token_bal(&env, &token, &client.address), 0);
    assert_eq!(client.get_deposit(&user), None);
    assert_eq!(token_bal(&env, &token, &user), 5_000);
    assert_eq!(token_bal(&env, &native, &client.address), native_before);
}

#[test]
fn accounting_drift_is_detected_on_repeated_and_boundary_ops() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, token, client) = setup(&env);
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&user, &10_000);

    client.deposit(&user, &1);
    assert_eq!(token_bal(&env, &token, &client.address), 1);

    for _ in 0..20 {
        client.deposit(&user, &10);
        client.withdrawal(&user, &7);
    }
    let recorded = client.get_deposit(&user).unwrap();
    assert_eq!(recorded, 1 + 20 * 3);
    assert_eq!(token_bal(&env, &token, &client.address), recorded);

    let overdraw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.withdrawal(&user, &(recorded + 1));
    }));
    assert!(overdraw.is_err());
    assert_eq!(token_bal(&env, &token, &client.address), recorded);
}

#[test]
fn zero_deposit_record_is_cleared_on_full_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, token, client) = setup(&env);
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&user, &50);
    client.deposit(&user, &50);
    client.withdrawal(&user, &50);
    assert_eq!(client.get_deposit(&user), None);
    assert_eq!(token_bal(&env, &token, &client.address), 0);
}
