#![cfg(test)]
extern crate std;
use super::*;
use soroban_sdk::{
    map,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Bytes, BytesN, Env,
};

const DEADLINE: u64 = 2_000;

/// Trustless Work testnet hattında her serbest bırakmada kesilen %0,3 protokol ücreti
fn net(gross: i128) -> i128 {
    gross - gross * 30 / 10_000
}

struct Setup<'a> {
    env: &'a Env,
    contract: EkIslerContractClient<'a>,
    token: TokenClient<'a>,
    tw_fee: Address,
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
    StellarAssetClient::new(env, &token_addr).mint(&client, &10_000_000);

    let tw_wasm = env.deployer().upload_contract_wasm(tw::WASM);
    let tw_fee = Address::generate(env);
    let contract_id = env.register(EkIslerContract, (tw_wasm, tw_fee.clone()));
    Setup {
        env,
        contract: EkIslerContractClient::new(env, &contract_id),
        token: TokenClient::new(env, &token_addr),
        tw_fee,
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

    /// Test kodu: paydaş i, dilim t için
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

    /// Kapanış parçalara bölündüyse bitene kadar devam ettirir
    fn finish(&self, id: u64) {
        while self.contract.get_job(&id).status == JobStatus::Closing {
            self.contract.continue_close(&id);
        }
    }

    fn escrow(&self, id: u64) -> tw::Client<'_> {
        tw::Client::new(self.env, &self.contract.get_job(&id).escrow)
    }
}

#[test]
fn creates_trustless_work_escrow_with_milestone_per_tranche() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000_000));
    let job = s.contract.get_job(&id);
    let e = s.escrow(id).get_escrow();

    // İhaleci 1 + iki çalışan × 3 dilim
    assert_eq!(e.milestones.len(), 7);
    assert_eq!(e.roles.approver, s.contract.address);
    assert_eq!(e.roles.release_signer, s.contract.address);
    assert_eq!(e.roles.dispute_resolver, s.arbiter);
    assert_eq!(e.milestones.get(0).unwrap().amount, 500_000);
    assert_eq!(e.milestones.get(0).unwrap().receiver, s.contractor);
    // w1 payı 320.000: 64.000 / 96.000 / 160.000
    assert_eq!(job.stakeholders.get(1).unwrap().first_milestone, 1);
    assert_eq!(e.milestones.get(1).unwrap().amount, 64_000);
    assert_eq!(e.milestones.get(2).unwrap().amount, 96_000);
    assert_eq!(e.milestones.get(3).unwrap().amount, 160_000);
    assert_eq!(e.milestones.get(3).unwrap().receiver, s.w1);
}

#[test]
fn happy_path_pays_everyone_through_trustless_work() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000_000));

    s.contract.accept_job(&id, &s.w1);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::PendingApproval);
    s.contract.accept_job(&id, &s.w2);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Approved);

    s.contract.deposit(&id, &s.commitments());
    let escrow_addr = s.contract.get_job(&id).escrow;
    assert_eq!(s.bal(&escrow_addr), 1_000_000);
    assert_eq!(s.bal(&s.contract.address), 0); // para Ek İşler'de değil, Trustless Work escrow'unda

    s.contract.complete_and_split(&id);
    s.finish(id);
    assert_eq!(s.bal(&s.contractor), net(500_000));
    assert_eq!(s.bal(&s.w1), net(64_000) + net(96_000) + net(160_000));
    assert_eq!(s.bal(&s.w2), net(36_000) + net(54_000) + net(90_000));
    assert_eq!(s.bal(&s.tw_fee), 3_000);
    assert_eq!(s.bal(&escrow_addr), 0);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Completed);
}

#[test]
fn qr_codes_release_milestones_progressively() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);

    assert_eq!(s.contract.claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(1, 0)), 64_000);
    assert_eq!(s.bal(&s.w1), net(64_000));
    assert!(s.escrow(id).get_escrow().milestones.get(1).unwrap().flags.released);

    assert_eq!(s.contract.claim(&id, &s.w1, &TRANCHE_MID, &s.code(1, 1)), 96_000);
    assert_eq!(s.contract.claim(&id, &s.w1, &TRANCHE_FINAL, &s.code(1, 2)), 160_000);
    let w1_total = net(64_000) + net(96_000) + net(160_000);
    assert_eq!(s.bal(&s.w1), w1_total);

    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &TRANCHE_FINAL, &s.code(1, 2)),
        Err(Ok(Error::AlreadyReleased))
    );

    // İşveren kapatınca kalanlar ödenir, w1'e fazladan ödeme yapılmaz
    s.contract.complete_and_split(&id);
    s.finish(id);
    assert_eq!(s.bal(&s.w1), w1_total);
    assert_eq!(s.bal(&s.contractor), net(500_000));
}

#[test]
fn final_qr_alone_releases_all_worker_milestones() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    assert_eq!(s.contract.claim(&id, &s.w2, &TRANCHE_FINAL, &s.code(2, 2)), 180_000);
    assert_eq!(s.contract.get_job(&id).stakeholders.get(2).unwrap().released, 0b111);
}

#[test]
fn wrong_or_foreign_code_is_rejected() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);

    let bogus = Bytes::from_array(&env, &[9, 9, 9]);
    assert_eq!(s.contract.try_claim(&id, &s.w1, &TRANCHE_ARRIVAL, &bogus), Err(Ok(Error::InvalidCode)));
    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(2, 0)),
        Err(Ok(Error::InvalidCode))
    );
    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(1, 2)),
        Err(Ok(Error::InvalidCode))
    );
    assert_eq!(s.bal(&s.w1), 0);
}

#[test]
fn deposit_requires_commitment_per_stakeholder_and_tranche() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000_000));
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
    let id = s.funded_job(1_000_000);

    let reading: BytesN<32> = env.crypto().sha256(&Bytes::from_array(&env, b"41.0336,28.9771,1000,tuz")).into();
    s.contract.submit_location(&id, &s.w1, &37, &reading);
    let proof = s.contract.get_job(&id).locations.get(0).unwrap();
    assert_eq!(proof.distance_m, 37);
    assert_eq!(proof.reading_hash, reading);

    assert_eq!(s.contract.arbiter_release(&id, &s.w1, &TRANCHE_ARRIVAL), 64_000);
    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&s.arbiter));
    assert_eq!(s.bal(&s.w1), net(64_000));
}

#[test]
fn employer_presence_check_pays_mid_or_raises_alert() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    s.contract.claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(1, 0));

    // Kod 2: işveren "burada değil" → para hareket etmez, çalışana uyarı
    assert_eq!(s.contract.confirm_presence(&id, &s.w1, &false), 0);
    let job = s.contract.get_job(&id);
    assert_eq!(job.alerts.len(), 1);
    assert_eq!(job.alerts.get(0).unwrap().kind, ALERT_REPORTED_ABSENT);
    assert_eq!(s.bal(&s.w1), net(64_000));

    // Kod 2: işveren "burada" → mesai dilimi ödenir
    assert_eq!(s.contract.confirm_presence(&id, &s.w1, &true), 96_000);
    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&s.client));
    assert_eq!(s.bal(&s.w1), net(64_000) + net(96_000));
    assert_eq!(
        s.contract.try_confirm_presence(&id, &s.w1, &true),
        Err(Ok(Error::AlreadyReleased))
    );
}

#[test]
fn leaving_the_area_raises_alert_for_employer() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    let h: BytesN<32> = env.crypto().sha256(&Bytes::from_array(&env, b"okuma")).into();

    s.contract.submit_location(&id, &s.w1, &120, &h); // alan içinde (300 m)
    assert_eq!(s.contract.get_job(&id).alerts.len(), 0);
    s.contract.submit_location(&id, &s.w1, &850, &h); // alan dışında
    let job = s.contract.get_job(&id);
    assert_eq!(job.alerts.len(), 1);
    let a = job.alerts.get(0).unwrap();
    assert_eq!((a.kind, a.distance_m, a.worker), (ALERT_LEFT_AREA, 850, s.w1.clone()));
}

#[test]
fn deadline_pays_those_who_showed_up_and_disputes_no_shows() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);

    // w1 geldi (varış kodu), w2 hiç gelmedi
    s.contract.claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(1, 0));

    assert_eq!(s.contract.try_release_after_deadline(&id), Err(Ok(Error::DeadlineNotReached)));
    env.ledger().set_timestamp(DEADLINE);
    s.contract.release_after_deadline(&id);
    s.finish(id);

    assert_eq!(s.bal(&s.w1), net(64_000) + net(96_000) + net(160_000));
    assert_eq!(s.bal(&s.w2), 0);
    assert_eq!(s.bal(&s.contractor), net(500_000));

    // w2'nin milestone'ları Trustless Work'te dispute'ta; hakem işverene iade eder
    let escrow = s.escrow(id);
    let e = escrow.get_escrow();
    for i in 4..7u32 {
        assert!(e.milestones.get(i).unwrap().flags.disputed);
    }
    let client_before = s.bal(&s.client);
    for i in 4..7u32 {
        let amount = e.milestones.get(i).unwrap().amount;
        escrow.resolve_milestone_dispute(&s.arbiter, &i, &s.tw_fee, &map![&env, (s.client.clone(), amount)]);
    }
    assert!(s.bal(&s.client) - client_before > 179_000);
    assert_eq!(s.bal(&s.contract.get_job(&id).escrow), 0);
}

#[test]
fn refund_keeps_released_tranches_with_worker() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    s.contract.claim(&id, &s.w1, &TRANCHE_MID, &s.code(1, 1)); // 64.000 + 96.000

    s.contract.refund(&id);
    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&s.client));
    assert!(signers.contains(&s.contractor));
    s.finish(id);

    assert_eq!(s.bal(&s.w1), net(64_000) + net(96_000));
    let e = s.escrow(id).get_escrow();
    assert!(e.milestones.get(0).unwrap().flags.disputed); // ihaleci payı
    assert!(!e.milestones.get(1).unwrap().flags.disputed); // ödenmiş kapora
    assert!(e.milestones.get(3).unwrap().flags.disputed); // w1 bitiş
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Refunded);
}

#[test]
fn contractor_cannot_accept_on_behalf_of_worker() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000_000));
    s.contract.accept_job(&id, &s.contractor);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::PendingApproval);
    assert_eq!(s.contract.try_deposit(&id, &s.commitments()), Err(Ok(Error::NotAllAccepted)));
}

#[test]
fn rejects_invalid_jobs() {
    let env = Env::default();
    let s = setup(&env);

    let mut t = s.terms(1_000_000);
    t.shares = vec![&env, ShareInput { address: s.contractor.clone(), share_bps: 5000 }];
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidShares)));

    let mut t = s.terms(1_000_000);
    t.shares = vec![
        &env,
        ShareInput { address: s.w1.clone(), share_bps: 5000 },
        ShareInput { address: s.w1.clone(), share_bps: 5000 },
    ];
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::DuplicateStakeholder)));

    assert_eq!(s.contract.try_create_job(&s.contractor, &s.terms(0)), Err(Ok(Error::InvalidAmount)));

    let mut t = s.terms(1_000_000);
    t.deadline = 500;
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidDeadline)));

    let mut t = s.terms(1_000_000);
    t.arrival_bps = 5000; // her dilim ayrı milestone: kapora mesaiden küçük olmalı
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidTranches)));

    let mut t = s.terms(1_000_000);
    t.arbiter = s.client.clone();
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidArbiter)));
}

#[test]
fn stranger_cannot_accept() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000_000));
    let stranger = Address::generate(&env);
    assert_eq!(s.contract.try_accept_job(&id, &stranger), Err(Ok(Error::NotStakeholder)));
}

#[test]
fn rounding_remainder_goes_to_contractor_milestone() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000_001));
    let e = s.escrow(id).get_escrow();
    assert_eq!(e.milestones.get(0).unwrap().amount, 500_001);
    let mut sum = 0;
    for m in e.milestones.iter() {
        sum += m.amount;
    }
    assert_eq!(sum, 1_000_001);
}

#[test]
fn cannot_complete_twice() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    s.contract.complete_and_split(&id);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Closing);
    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(1, 0)),
        Err(Ok(Error::InvalidStatus))
    );
    s.finish(id);
    assert_eq!(s.contract.try_continue_close(&id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(s.contract.try_complete_and_split(&id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(s.contract.try_refund(&id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &TRANCHE_ARRIVAL, &s.code(1, 0)),
        Err(Ok(Error::InvalidStatus))
    );
}

