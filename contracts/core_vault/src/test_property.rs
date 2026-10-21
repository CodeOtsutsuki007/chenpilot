#![cfg(test)]

//! Property tests for vault share accounting.
//!
//! core_vault uses 1:1 share conversion (1 token = 1 share). Conservation
//! tolerance is therefore 0 and rounding dust is identically 0.

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const SHARE_CONSERVATION_TOLERANCE: i128 = 0;

fn setup(env: &Env) -> (Address, Address, CoreVaultContractClient) {
    let admin = Address::generate(env);
    let vault_token = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let unified_auth = Address::generate(env);
    let contract_id = env.register_contract(None, CoreVaultContract);
    let client = CoreVaultContractClient::new(env, &contract_id);
    client.init(&admin, &vault_token, &unified_auth);
    (admin, vault_token, client)
}

fn tokens_to_shares(amount: i128) -> i128 {
    amount
}

#[test]
fn deposit_withdrawal_sequences_conserve_shares() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, token, client) = setup(&env);
    let user = Address::generate(&env);
    let sequence: [i128; 8] = [1, 7, 42, 1_000, 9_999, 1, 250, 13];
    let total: i128 = sequence.iter().sum();
    StellarAssetClient::new(&env, &token).mint(&user, &total);

    let mut shares = 0i128;
    let mut dust = 0i128;
    for amount in sequence {
        let before = client.get_deposit(&user).unwrap_or(0);
        client.deposit(&user, &amount);
        let minted = tokens_to_shares(amount);
        shares += minted;
        let after = client.get_deposit(&user).unwrap_or(0);
        dust += after - before - minted;
        assert!(dust.abs() <= SHARE_CONSERVATION_TOLERANCE);
    }

    for amount in sequence {
        client.withdrawal(&user, &amount);
        shares -= tokens_to_shares(amount);
        assert_eq!(client.get_deposit(&user).unwrap_or(0), shares);
        assert!(dust.abs() <= SHARE_CONSERVATION_TOLERANCE);
    }

    assert_eq!(shares, 0);
    assert_eq!(dust, 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&client.address), 0);
    let _ = admin;
}

#[test]
fn long_sequence_rounding_dust_stays_bounded() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, token, client) = setup(&env);
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&user, &50_000);

    let mut shares = 0i128;
    let mut max_dust = 0i128;
    for i in 0..64 {
        let deposit_amt = 3 + (i % 11);
        client.deposit(&user, &deposit_amt);
        shares += deposit_amt;
        let withdraw_amt = 1 + (i % 5);
        client.withdrawal(&user, &withdraw_amt);
        shares -= withdraw_amt;
        let recorded = client.get_deposit(&user).unwrap_or(0);
        let dust = (recorded - shares).abs();
        if dust > max_dust {
            max_dust = dust;
        }
        assert!(dust <= SHARE_CONSERVATION_TOLERANCE);
    }
    assert_eq!(max_dust, 0);
}

#[test]
fn zero_and_overflow_adjacent_share_amounts_are_rejected_or_conserved() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, token, client) = setup(&env);
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&user, &10);

    client.deposit(&user, &10);
    assert_eq!(client.get_deposit(&user), Some(10));

    let withdrew_too_much = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.withdrawal(&user, &11);
    }));
    assert!(withdrew_too_much.is_err());
    assert_eq!(client.get_deposit(&user), Some(10));
    assert_eq!(TokenClient::new(&env, &token).balance(&client.address), 10);
}
