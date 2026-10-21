#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
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

#[test]
fn nonce_advances_only_after_successful_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _token, client) = setup(&env);

    assert_eq!(client.auth_nonce(&admin), 0);
    client.pause();
    assert_eq!(client.auth_nonce(&admin), 1);
    client.unpause();
    assert_eq!(client.auth_nonce(&admin), 2);
}

#[test]
fn failed_authorization_does_not_mutate_nonce() {
    let env = Env::default();
    let (admin, _token, client) = setup(&env);

    assert_eq!(client.auth_nonce(&admin), 0);
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.pause();
    }));
    assert!(panicked.is_err());
    assert_eq!(client.auth_nonce(&admin), 0);
}

#[test]
fn nonce_overflow_fails_before_wraparound() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _token, client) = setup(&env);

    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::AuthNonce(admin.clone()), &u32::MAX);
    });
    assert_eq!(client.auth_nonce(&admin), u32::MAX);

    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.pause();
    }));
    assert!(panicked.is_err());
    assert_eq!(client.auth_nonce(&admin), u32::MAX);
}

#[test]
fn nonce_boundary_max_minus_one_still_advances() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, token, client) = setup(&env);
    let _ = TokenClient::new(&env, &token);
    let _ = StellarAssetClient::new(&env, &token);

    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::AuthNonce(admin.clone()), &(u32::MAX - 1));
    });

    client.pause();
    assert_eq!(client.auth_nonce(&admin), u32::MAX);
}
