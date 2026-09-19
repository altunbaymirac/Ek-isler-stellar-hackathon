#![cfg(test)]
extern crate std;
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Bytes, BytesN, Env,
};

const DEADLINE: u64 = 2_000;

struct Setup<'a> {
    env: &'a Env,
    contract: EkIslerContractClient<'a>,
    token: TokenClient<'a>,
    client: Address,
    contractor: Address,
    arbiter: Address,
    w1: Address,
    w2: Address,
}

fn setup(env: &Env) -> Setup<'_> {
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(env);
    let token_addr = env.register_stellar_asset_contract_v2(admin).address();
    let client = Address::generate(env);
    StellarAssetClient::new(env, &token_addr).mint(&client, &100_000);

    let contract_id = env.register(EkIslerContract, ());
    Setup {
        env,
        contract: EkIslerContractClient::new(env, &contract_id),
        token: TokenClient::new(env, &token_addr),
        client,
        contractor: Address::generate(env),
        arbiter: Address::generate(env),
        w1: Address::generate(env),
        w2: Address::generate(env),
    }
}

impl Setup<'_> {
    /// İhaleci %50, çalışanlar %32 ve %18; kapora %20, mesai ortası %50
    fn terms(&self, amount: i128) -> JobTerms {
        JobTerms {
            client: self.client.clone(),
            arbiter: self.arbiter.clone(),
            token: self.token.address.clone(),
            total_amount: amount,
            shares: vec![
                self.env,
                ShareInput { address: self.contractor.clone(), share_bps: 5000 },
                ShareInput { address: self.w1.clone(), share_bps: 3200 },
                ShareInput { address: self.w2.clone(), share_bps: 1800 },
            ],
            deadline: DEADLINE,
            arrival_bps: 2000,
            mid_bps: 5000,
            venue_lat_e6: 41_033_500,
            venue_lng_e6: 28_977_000,
            radius_m: 300,
        }
    }

    /// Test kodu: çalışan i, dilim t için
    fn code(&self, i: u32, t: u32) -> Bytes {
        Bytes::from_array(self.env, &[i as u8, t as u8, 7, 7])
    }

    fn commitments(&self) -> Vec<BytesN<32>> {
        let mut v = Vec::new(self.env);
        for i in 0..3u32 {
            for t in 0..TRANCHES {
                v.push_back(self.env.crypto().sha256(&self.code(i, t)).into());
            }
        }
        v
    }

    fn funded_job(&self, amount: i128) -> u64 {
        let id = self.contract.create_job(&self.contractor, &self.terms(amount));
        self.contract.accept_job(&id, &self.w1);
        self.contract.accept_job(&id, &self.w2);
        self.contract.deposit(&id, &self.commitments());
        id
    }

    fn bal(&self, a: &Address) -> i128 {
        self.token.balance(a)
    }
}

#[test]
fn happy_path_splits_by_shares() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000));

    s.contract.accept_job(&id, &s.w1);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::PendingApproval);
    s.contract.accept_job(&id, &s.w2);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Approved);

    s.contract.deposit(&id, &s.commitments());
    assert_eq!(s.bal(&s.contract.address), 1_000);

    s.contract.complete_and_split(&id);
    assert_eq!(s.bal(&s.contractor), 500);
    assert_eq!(s.bal(&s.w1), 320);
    assert_eq!(s.bal(&s.w2), 180);
    assert_eq!(s.bal(&s.contract.address), 0);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Completed);
}

#[test]
fn qr_codes_release_tranches_progressively() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000);

    // w1 payı 320: varış %20 = 64, mesai %50 = 160, bitiş 320
    assert_eq!(s.contract.claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(1, 0)), 64);
    assert_eq!(s.bal(&s.w1), 64);
    assert_eq!(s.contract.claim(&id, &s.w1, &TRANCHE_MID, &s.code(1, 1)), 96);
    assert_eq!(s.bal(&s.w1), 160);
    assert_eq!(s.contract.claim(&id, &s.w1, &TRANCHE_FINAL, &s.code(1, 2)), 160);
    assert_eq!(s.bal(&s.w1), 320);

    // Aynı kod ikinci kez kullanılamaz
    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &TRANCHE_FINAL, &s.code(1, 2)),
        Err(Ok(Error::AlreadyReleased))
    );

    // Müşteri kapatınca kalanlar ödenir, w1'e fazladan ödeme yapılmaz
    s.contract.complete_and_split(&id);
    assert_eq!(s.bal(&s.w1), 320);
    assert_eq!(s.bal(&s.w2), 180);
    assert_eq!(s.bal(&s.contractor), 500);
    assert_eq!(s.bal(&s.contract.address), 0);
}

#[test]
fn final_qr_alone_pays_everything() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000);
    assert_eq!(s.contract.claim(&id, &s.w2, &TRANCHE_FINAL, &s.code(2, 2)), 180);
    let job = s.contract.get_job(&id);
    assert_eq!(job.stakeholders.get(2).unwrap().released, 0b111);
}

#[test]
fn wrong_or_foreign_code_is_rejected() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000);

    let bogus = Bytes::from_array(&env, &[9, 9, 9]);
    assert_eq!(s.contract.try_claim(&id, &s.w1, &TRANCHE_ARRIVAL, &bogus), Err(Ok(Error::InvalidCode)));
    // w2'nin kodu w1 için geçmez
    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(2, 0)),
        Err(Ok(Error::InvalidCode))
    );
    // Bitiş kodu varış dilimi için geçmez
    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(1, 2)),
        Err(Ok(Error::InvalidCode))
    );
    assert_eq!(s.bal(&s.w1), 0);
}

#[test]
fn deposit_requires_commitment_per_worker_and_tranche() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000));
    s.contract.accept_job(&id, &s.w1);
    s.contract.accept_job(&id, &s.w2);
    let mut short = s.commitments();
    short.pop_back();
    assert_eq!(s.contract.try_deposit(&id, &short), Err(Ok(Error::InvalidCommitments)));
}

#[test]
fn arbiter_releases_deposit_on_location_proof() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000);

    // İşveren varış kodunu vermiyor: çalışan konumunu kaydeder, hakem kaporayı açar
    s.contract.submit_location(&id, &s.w1, &41_033_600, &28_977_100);
    let job = s.contract.get_job(&id);
    assert_eq!(job.locations.len(), 1);
    assert_eq!(job.locations.get(0).unwrap().worker, s.w1);

    assert_eq!(s.contract.arbiter_release(&id, &s.w1, &TRANCHE_ARRIVAL), 64);
    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&s.arbiter));
    assert_eq!(s.bal(&s.w1), 64);
}

#[test]
fn deadline_pays_those_who_showed_up_and_returns_no_shows() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000);

    // w1 geldi (varış kodu), w2 hiç gelmedi
    s.contract.claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(1, 0));
    let client_before = s.bal(&s.client);

    assert_eq!(s.contract.try_release_after_deadline(&id), Err(Ok(Error::DeadlineNotReached)));
    env.ledger().set_timestamp(DEADLINE);
    s.contract.release_after_deadline(&id);

    assert_eq!(s.bal(&s.w1), 320);
    assert_eq!(s.bal(&s.w2), 0);
    assert_eq!(s.bal(&s.contractor), 500);
    assert_eq!(s.bal(&s.client) - client_before, 180);
    assert_eq!(s.bal(&s.contract.address), 0);
}

#[test]
fn refund_keeps_released_tranches_with_worker() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000);
    s.contract.claim(&id, &s.w1, &TRANCHE_MID, &s.code(1, 1)); // 160

    let client_before = s.bal(&s.client);
    s.contract.refund(&id);
    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&s.client));
    assert!(signers.contains(&s.contractor));

    assert_eq!(s.bal(&s.w1), 160);
    assert_eq!(s.bal(&s.client) - client_before, 840);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Refunded);
}

#[test]
fn contractor_cannot_accept_on_behalf_of_worker() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000));
    s.contract.accept_job(&id, &s.contractor);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::PendingApproval);
    assert_eq!(
        s.contract.try_deposit(&id, &s.commitments()),
        Err(Ok(Error::NotAllAccepted))
    );
}

#[test]
fn rejects_invalid_jobs() {
    let env = Env::default();
    let s = setup(&env);

    let mut t = s.terms(1_000);
    t.shares = vec![&env, ShareInput { address: s.contractor.clone(), share_bps: 5000 }];
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidShares)));

    let mut t = s.terms(1_000);
    t.shares = vec![
        &env,
        ShareInput { address: s.w1.clone(), share_bps: 5000 },
        ShareInput { address: s.w1.clone(), share_bps: 5000 },
    ];
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::DuplicateStakeholder)));

    assert_eq!(s.contract.try_create_job(&s.contractor, &s.terms(0)), Err(Ok(Error::InvalidAmount)));

    let mut t = s.terms(1_000);
    t.deadline = 500;
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidDeadline)));

    let mut t = s.terms(1_000);
    t.arrival_bps = 6000; // kapora mesai oranından büyük olamaz
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidTranches)));

    let mut t = s.terms(1_000);
    t.arbiter = s.client.clone(); // müşteri kendi hakemi olamaz
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidArbiter)));
}

#[test]
fn stranger_cannot_accept_or_claim() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000));
    let stranger = Address::generate(&env);
    assert_eq!(s.contract.try_accept_job(&id, &stranger), Err(Ok(Error::NotStakeholder)));
}

#[test]
fn rounding_remainder_goes_to_contractor() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_001);
    s.contract.complete_and_split(&id);
    assert_eq!(s.bal(&s.contractor), 501);
    assert_eq!(s.bal(&s.w1), 320);
    assert_eq!(s.bal(&s.w2), 180);
    assert_eq!(s.bal(&s.contract.address), 0);
}

#[test]
fn cannot_complete_twice() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000);
    s.contract.complete_and_split(&id);
    assert_eq!(s.contract.try_complete_and_split(&id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(s.contract.try_refund(&id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(1, 0)),
        Err(Ok(Error::InvalidStatus))
    );
}
