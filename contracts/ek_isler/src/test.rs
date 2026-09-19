#![cfg(test)]
extern crate std;
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env,
};

const DEADLINE: u64 = 2_000;

struct Setup<'a> {
    contract: EkIslerContractClient<'a>,
    token: TokenClient<'a>,
    client: Address,
    contractor: Address,
    w1: Address,
    w2: Address,
}

fn setup(env: &Env) -> Setup<'_> {
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(env);
    let token_addr = env.register_stellar_asset_contract_v2(admin).address();
    let client = Address::generate(env);
    StellarAssetClient::new(env, &token_addr).mint(&client, &10_000);

    let contract_id = env.register(EkIslerContract, ());
    Setup {
        contract: EkIslerContractClient::new(env, &contract_id),
        token: TokenClient::new(env, &token_addr),
        client,
        contractor: Address::generate(env),
        w1: Address::generate(env),
        w2: Address::generate(env),
    }
}

/// İhaleci %50, çalışanlar %32 ve %18
fn shares(env: &Env, s: &Setup, pre_accepted: bool) -> Vec<Stakeholder> {
    vec![
        env,
        Stakeholder { address: s.contractor.clone(), share_bps: 5000, accepted: pre_accepted },
        Stakeholder { address: s.w1.clone(), share_bps: 3200, accepted: pre_accepted },
        Stakeholder { address: s.w2.clone(), share_bps: 1800, accepted: pre_accepted },
    ]
}

fn create(env: &Env, s: &Setup, amount: i128) -> u64 {
    s.contract.create_job(
        &s.client,
        &s.contractor,
        &s.token.address,
        &amount,
        &shares(env, s, false),
        &DEADLINE,
    )
}

#[test]
fn happy_path_splits_by_shares() {
    let env = Env::default();
    let s = setup(&env);
    let id = create(&env, &s, 1_000);

    s.contract.accept_job(&id, &s.w1);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::PendingApproval);
    s.contract.accept_job(&id, &s.w2);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Approved);

    s.contract.deposit(&id);
    assert_eq!(s.token.balance(&s.contract.address), 1_000);

    s.contract.complete_and_split(&id);
    assert_eq!(s.token.balance(&s.contractor), 500);
    assert_eq!(s.token.balance(&s.w1), 320);
    assert_eq!(s.token.balance(&s.w2), 180);
    assert_eq!(s.token.balance(&s.contract.address), 0);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Completed);
}

#[test]
fn contractor_cannot_pre_accept_for_workers() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(
        &s.client,
        &s.contractor,
        &s.token.address,
        &1_000,
        &shares(&env, &s, true),
        &DEADLINE,
    );

    let job = s.contract.get_job(&id);
    assert_eq!(job.status, JobStatus::PendingApproval);
    assert!(job.stakeholders.get(0).unwrap().accepted); // ihalecinin kendisi
    assert!(!job.stakeholders.get(1).unwrap().accepted);
    assert!(!job.stakeholders.get(2).unwrap().accepted);

    assert_eq!(s.contract.try_deposit(&id), Err(Ok(Error::NotAllAccepted)));
}

#[test]
fn contractor_cannot_accept_on_behalf_of_worker() {
    let env = Env::default();
    let s = setup(&env);
    let id = create(&env, &s, 1_000);

    // İhaleci kendi adresiyle accept çağırsa bile çalışanlar onaylanmış olmaz
    s.contract.accept_job(&id, &s.contractor);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::PendingApproval);
}

#[test]
fn rejects_invalid_jobs() {
    let env = Env::default();
    let s = setup(&env);
    let bad_sum = vec![
        &env,
        Stakeholder { address: s.contractor.clone(), share_bps: 5000, accepted: false },
        Stakeholder { address: s.w1.clone(), share_bps: 2000, accepted: false },
    ];
    let dup = vec![
        &env,
        Stakeholder { address: s.w1.clone(), share_bps: 5000, accepted: false },
        Stakeholder { address: s.w1.clone(), share_bps: 5000, accepted: false },
    ];
    let good = shares(&env, &s, false);
    let tk = &s.token.address;

    let r = s.contract.try_create_job(&s.client, &s.contractor, tk, &1_000, &bad_sum, &DEADLINE);
    assert_eq!(r, Err(Ok(Error::InvalidShares)));
    let r = s.contract.try_create_job(&s.client, &s.contractor, tk, &1_000, &dup, &DEADLINE);
    assert_eq!(r, Err(Ok(Error::DuplicateStakeholder)));
    let r = s.contract.try_create_job(&s.client, &s.contractor, tk, &0, &good, &DEADLINE);
    assert_eq!(r, Err(Ok(Error::InvalidAmount)));
    let r = s.contract.try_create_job(&s.client, &s.contractor, tk, &1_000, &good, &500);
    assert_eq!(r, Err(Ok(Error::InvalidDeadline)));
}

#[test]
fn stranger_cannot_accept() {
    let env = Env::default();
    let s = setup(&env);
    let id = create(&env, &s, 1_000);
    let stranger = Address::generate(&env);
    assert_eq!(s.contract.try_accept_job(&id, &stranger), Err(Ok(Error::NotStakeholder)));
}

#[test]
fn rounding_remainder_goes_to_contractor() {
    let env = Env::default();
    let s = setup(&env);
    let id = create(&env, &s, 1_001);
    s.contract.accept_job(&id, &s.w1);
    s.contract.accept_job(&id, &s.w2);
    s.contract.deposit(&id);
    s.contract.complete_and_split(&id);

    assert_eq!(s.token.balance(&s.contractor), 501);
    assert_eq!(s.token.balance(&s.w1), 320);
    assert_eq!(s.token.balance(&s.w2), 180);
    assert_eq!(s.token.balance(&s.contract.address), 0);
}

#[test]
fn release_after_deadline_pays_workers() {
    let env = Env::default();
    let s = setup(&env);
    let id = create(&env, &s, 1_000);
    s.contract.accept_job(&id, &s.w1);
    s.contract.accept_job(&id, &s.w2);
    s.contract.deposit(&id);

    assert_eq!(
        s.contract.try_release_after_deadline(&id),
        Err(Ok(Error::DeadlineNotReached))
    );

    env.ledger().set_timestamp(DEADLINE);
    s.contract.release_after_deadline(&id);
    assert_eq!(s.token.balance(&s.w1), 320);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Completed);
}

#[test]
fn refund_requires_client_and_contractor() {
    let env = Env::default();
    let s = setup(&env);
    let id = create(&env, &s, 1_000);
    s.contract.accept_job(&id, &s.w1);
    s.contract.accept_job(&id, &s.w2);
    s.contract.deposit(&id);

    s.contract.refund(&id);
    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&s.client));
    assert!(signers.contains(&s.contractor));

    assert_eq!(s.token.balance(&s.client), 10_000);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Refunded);
}

#[test]
fn cannot_complete_twice() {
    let env = Env::default();
    let s = setup(&env);
    let id = create(&env, &s, 1_000);
    s.contract.accept_job(&id, &s.w1);
    s.contract.accept_job(&id, &s.w2);
    s.contract.deposit(&id);
    s.contract.complete_and_split(&id);

    assert_eq!(s.contract.try_complete_and_split(&id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(s.contract.try_refund(&id), Err(Ok(Error::InvalidStatus)));
}
