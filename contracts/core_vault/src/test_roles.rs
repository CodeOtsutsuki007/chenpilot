#![cfg(test)]

//! Role-matrix coverage for every privileged core_vault entry point.
//! The table in AUTHORIZATION_MATRICES.md is the source of truth.

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::StellarAssetClient,
    Address, BytesN, Env,
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

fn dummy_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[7u8; 32])
}

fn must_reject<F: FnOnce()>(f: F) {
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err(),
        "privileged entry point must reject unauthorized callers"
    );
}

#[test]
fn authorized_admin_can_call_privileged_entry_points() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, token, client) = setup(&env);
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&user, &1_000);
    client.deposit(&user, &200);

    client.set_backend_status(&true);
    client.pause();
    client.unpause();
    client.propose_upgrade(&dummy_hash(&env));
    client.cancel_upgrade();
    client.set_unified_auth(&Address::generate(&env));
    client.transfer_admin(&Address::generate(&env));
}

#[test]
fn unauthorized_caller_is_rejected_for_pause() {
    let env = Env::default();
    let (_admin, _token, client) = setup(&env);
    must_reject(|| {
        client.pause();
    });
}

#[test]
fn unauthorized_caller_is_rejected_for_unpause() {
    let env = Env::default();
    let (_admin, _token, client) = setup(&env);
    must_reject(|| {
        client.unpause();
    });
}

#[test]
fn unauthorized_caller_is_rejected_for_backend_status() {
    let env = Env::default();
    let (_admin, _token, client) = setup(&env);
    must_reject(|| {
        client.set_backend_status(&false);
    });
}

#[test]
fn unauthorized_caller_is_rejected_for_upgrade_and_admin_transfer() {
    let env = Env::default();
    let (_admin, _token, client) = setup(&env);
    must_reject(|| {
        client.propose_upgrade(&dummy_hash(&env));
    });
    must_reject(|| {
        client.cancel_upgrade();
    });
    must_reject(|| {
        client.set_unified_auth(&Address::generate(&env));
    });
    must_reject(|| {
        client.transfer_admin(&Address::generate(&env));
    });
}

#[test]
fn unauthorized_caller_is_rejected_for_recovery() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, token, client) = setup(&env);
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&user, &500);
    client.deposit(&user, &500);
    client.set_backend_status(&false);
    client.force_exit_request(&user);

    env.set_auths(&[]);
    must_reject(|| {
        client.recovery(&user);
    });
}

#[test]
fn pause_blocks_backend_status_and_upgrade_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _token, client) = setup(&env);

    client.pause();
    must_reject(|| {
        client.set_backend_status(&false);
    });
    must_reject(|| {
        client.propose_upgrade(&dummy_hash(&env));
    });
}

#[test]
fn user_entry_points_still_require_the_user() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, token, client) = setup(&env);
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&user, &100);
    client.deposit(&user, &100);

    env.set_auths(&[]);
    must_reject(|| {
        client.withdrawal(&user, &10);
    });
}
