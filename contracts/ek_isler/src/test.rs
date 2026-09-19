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
const WORK_START: u64 = 1_000;
const WORK_END: u64 = 1_800;
/// Kod 2 yoklaması çalışma saatlerinin tam ortasında açılır: (1000 + 1800) / 2
const PRESENCE_AT: u64 = 1_400;

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
    /// İhaleci %50, çalışanlar %32 ve %18. Kapora yok: ödeme gün sonunda tek seferde.
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
            work_start: WORK_START,
            work_end: WORK_END,
            venue_lat_e6: 41_033_500,
            venue_lng_e6: 28_977_000,
            radius_m: 300,
        }
    }

    /// Test kodu: paydaş i, kod türü k (0 = Kod 1, 1 = gün sonu), kod seti `tag`
    fn code_tagged(&self, i: u32, k: u32, tag: u8) -> Bytes {
        Bytes::from_array(self.env, &[i as u8, k as u8, 7, tag])
    }

    fn code(&self, i: u32, k: u32) -> Bytes {
        self.code_tagged(i, k, 0)
    }

    fn commitments_tagged(&self, tag: u8) -> Vec<BytesN<32>> {
        let mut v = Vec::new(self.env);
        for i in 0..3u32 {
            for k in 0..CODES {
                v.push_back(self.env.crypto().sha256(&self.code_tagged(i, k, tag)).into());
            }
        }
        v
    }

    fn commitments(&self) -> Vec<BytesN<32>> {
        self.commitments_tagged(0)
    }

    fn funded_job(&self, amount: i128) -> u64 {
        let id = self.contract.create_job(&self.contractor, &self.terms(amount));
        self.contract.accept_job(&id, &self.w1);
        self.contract.accept_job(&id, &self.w2);
        self.contract.deposit(&id);
        self.contract.set_codes(&id, &self.commitments());
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

    fn stake(&self, id: u64, i: u32) -> Stakeholder {
        self.contract.get_job(&id).stakeholders.get(i).unwrap()
    }
}

#[test]
fn creates_one_trustless_work_milestone_per_stakeholder() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000_000));
    let e = s.escrow(id).get_escrow();

    // Kapora olmadığı için paydaş başına tek milestone: ihaleci + 2 çalışan
    assert_eq!(e.milestones.len(), 3);
    assert_eq!(e.roles.approver, s.contract.address);
    assert_eq!(e.roles.release_signer, s.contract.address);
    assert_eq!(e.roles.dispute_resolver, s.arbiter);
    assert_eq!(e.milestones.get(0).unwrap().amount, 500_000);
    assert_eq!(e.milestones.get(0).unwrap().receiver, s.contractor);
    assert_eq!(e.milestones.get(1).unwrap().amount, 320_000);
    assert_eq!(e.milestones.get(1).unwrap().receiver, s.w1);
    assert_eq!(e.milestones.get(2).unwrap().amount, 180_000);
    assert_eq!(s.stake(id, 1).milestone, 1);
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

    s.contract.deposit(&id);
    let escrow_addr = s.contract.get_job(&id).escrow;
    assert_eq!(s.bal(&escrow_addr), 1_000_000);
    assert_eq!(s.bal(&s.contract.address), 0); // para Ek İşler'de değil, Trustless Work escrow'unda

    s.contract.complete_and_split(&id);
    s.finish(id);
    assert_eq!(s.bal(&s.contractor), net(500_000));
    assert_eq!(s.bal(&s.w1), net(320_000));
    assert_eq!(s.bal(&s.w2), net(180_000));
    assert_eq!(s.bal(&s.tw_fee), 3_000);
    assert_eq!(s.bal(&escrow_addr), 0);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Completed);
}

#[test]
fn code_1_proves_arrival_without_paying_anything() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);

    assert!(!s.stake(id, 1).arrived);
    s.contract.check_in(&id, &s.w1, &s.code(1, CODE_ARRIVAL));

    let w1 = s.stake(id, 1);
    assert!(w1.arrived);
    assert!(!w1.released);
    assert_eq!(w1.paid, 0);
    assert_eq!(s.bal(&s.w1), 0); // Kod 1 para ödemez
    assert!(!s.escrow(id).get_escrow().milestones.get(1).unwrap().flags.released);

    // Aynı kod ikinci kez kullanılamaz
    assert_eq!(
        s.contract.try_check_in(&id, &s.w1, &s.code(1, CODE_ARRIVAL)),
        Err(Ok(Error::AlreadyArrived))
    );
}

#[test]
fn final_code_pays_the_whole_share_at_once() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    s.contract.check_in(&id, &s.w1, &s.code(1, CODE_ARRIVAL));

    assert_eq!(s.contract.claim(&id, &s.w1, &s.code(1, CODE_FINAL)), 320_000);
    assert_eq!(s.bal(&s.w1), net(320_000));
    assert!(s.escrow(id).get_escrow().milestones.get(1).unwrap().flags.released);

    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &s.code(1, CODE_FINAL)),
        Err(Ok(Error::AlreadyReleased))
    );

    // İşveren kapatınca kalanlar ödenir, w1'e fazladan ödeme yapılmaz
    s.contract.complete_and_split(&id);
    s.finish(id);
    assert_eq!(s.bal(&s.w1), net(320_000));
    assert_eq!(s.bal(&s.contractor), net(500_000));
}

#[test]
fn final_code_alone_also_proves_arrival() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    assert_eq!(s.contract.claim(&id, &s.w2, &s.code(2, CODE_FINAL)), 180_000);
    let w2 = s.stake(id, 2);
    assert!(w2.arrived);
    assert!(w2.released);
}

#[test]
fn wrong_or_foreign_code_is_rejected() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);

    let bogus = Bytes::from_array(&env, &[9, 9, 9]);
    assert_eq!(s.contract.try_check_in(&id, &s.w1, &bogus), Err(Ok(Error::InvalidCode)));
    // Başka çalışanın Kod 1'i
    assert_eq!(
        s.contract.try_check_in(&id, &s.w1, &s.code(2, CODE_ARRIVAL)),
        Err(Ok(Error::InvalidCode))
    );
    // Kendi gün sonu kodu Kod 1 yerine kullanılamaz
    assert_eq!(
        s.contract.try_check_in(&id, &s.w1, &s.code(1, CODE_FINAL)),
        Err(Ok(Error::InvalidCode))
    );
    // Kod 1 ile ödeme alınamaz
    assert_eq!(
        s.contract.try_claim(&id, &s.w1, &s.code(1, CODE_ARRIVAL)),
        Err(Ok(Error::InvalidCode))
    );
    assert_eq!(s.bal(&s.w1), 0);
    assert!(!s.stake(id, 1).arrived);
}

#[test]
fn codes_are_set_by_contractor_and_required() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000_000));
    s.contract.accept_job(&id, &s.w1);
    s.contract.accept_job(&id, &s.w2);
    s.contract.deposit(&id);

    assert_eq!(
        s.contract.try_check_in(&id, &s.w1, &s.code(1, CODE_ARRIVAL)),
        Err(Ok(Error::CodesNotSet))
    );

    s.contract.set_codes(&id, &s.commitments());
    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&s.contractor)); // işveren değil, ihaleci imzalar
    s.contract.check_in(&id, &s.w1, &s.code(1, CODE_ARRIVAL));
    assert!(s.stake(id, 1).arrived);
}

#[test]
fn set_codes_requires_two_commitments_per_stakeholder() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000_000));
    s.contract.accept_job(&id, &s.w1);
    s.contract.accept_job(&id, &s.w2);
    let mut short = s.commitments();
    short.pop_back();
    assert_eq!(s.contract.try_set_codes(&id, &short), Err(Ok(Error::InvalidCommitments)));
}

#[test]
fn contractor_can_replace_codes_without_touching_paid_shares() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    s.contract.claim(&id, &s.w1, &s.code(1, CODE_FINAL));

    // İhaleci cihaz değiştirdi: yeni kod seti belirlenir, eskiler geçersiz olur
    s.contract.set_codes(&id, &s.commitments_tagged(9));
    assert_eq!(
        s.contract.try_check_in(&id, &s.w2, &s.code(2, CODE_ARRIVAL)),
        Err(Ok(Error::InvalidCode))
    );
    s.contract.check_in(&id, &s.w2, &s.code_tagged(2, CODE_ARRIVAL, 9));
    assert!(s.stake(id, 2).arrived);
    assert_eq!(s.bal(&s.w1), net(320_000)); // ödenmiş pay etkilenmedi
}

#[test]
fn presence_check_never_moves_money() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    s.contract.check_in(&id, &s.w1, &s.code(1, CODE_ARRIVAL));
    env.ledger().set_timestamp(PRESENCE_AT); // yoklama penceresi açıldı

    // Kod 2: "çalışmıyor" → para hareket etmez, çalışana uyarı
    s.contract.confirm_presence(&id, &s.w1, &false);
    let job = s.contract.get_job(&id);
    assert_eq!(job.alerts.len(), 1);
    assert_eq!(job.alerts.get(0).unwrap().kind, ALERT_REPORTED_ABSENT);
    assert_eq!(s.bal(&s.w1), 0);

    // Kod 2: "çalışıyor" → yine para hareket etmez, yalnızca yoklama sayılır
    s.contract.confirm_presence(&id, &s.w1, &true);
    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&s.contractor)); // yoklamayı sahadaki ihaleci yapar
    assert_eq!(s.bal(&s.w1), 0);
    assert_eq!(s.stake(id, 1).checks, 1);
    assert!(!s.stake(id, 1).released);
}

#[test]
fn presence_check_only_inside_the_window() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    s.contract.check_in(&id, &s.w1, &s.code(1, CODE_ARRIVAL));

    // Çalışma saatlerinin ortasından önce yoklama yapılamaz
    assert_eq!(
        s.contract.try_confirm_presence(&id, &s.w1, &true),
        Err(Ok(Error::PresenceWindowClosed))
    );

    // Tam ortada açılır
    env.ledger().set_timestamp(PRESENCE_AT);
    s.contract.confirm_presence(&id, &s.w1, &true);
    assert_eq!(s.stake(id, 1).checks, 1);

    // 15 dakika sonra kapanır
    env.ledger().set_timestamp(PRESENCE_AT + 15 * 60);
    assert_eq!(
        s.contract.try_confirm_presence(&id, &s.w1, &true),
        Err(Ok(Error::PresenceWindowClosed))
    );
}

#[test]
fn bulk_presence_check_flags_only_the_named_workers() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    s.contract.check_in(&id, &s.w1, &s.code(1, CODE_ARRIVAL));
    s.contract.check_in(&id, &s.w2, &s.code(2, CODE_ARRIVAL));

    env.ledger().set_timestamp(PRESENCE_AT);
    // İhaleciye giden tek bildirimin yanıtı: w2 çalışmıyor, geri kalan herkes çalışıyor
    s.contract.confirm_presence_all(&id, &vec![&env, s.w2.clone()]);

    let job = s.contract.get_job(&id);
    assert_eq!(job.alerts.len(), 1);
    let a = job.alerts.get(0).unwrap();
    assert_eq!((a.kind, a.worker.clone()), (ALERT_REPORTED_ABSENT, s.w2.clone()));
    assert_eq!(s.stake(id, 1).checks, 1); // w1 çalışıyor sayıldı
    assert_eq!(s.stake(id, 2).checks, 0); // w2 sayılmadı
    assert_eq!(s.bal(&s.w1), 0); // hiçbir durumda para hareket etmez
    assert_eq!(s.bal(&s.w2), 0);
}

#[test]
fn bulk_presence_check_rejects_outsiders() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    env.ledger().set_timestamp(PRESENCE_AT);
    let stranger = Address::generate(&env);
    assert_eq!(
        s.contract.try_confirm_presence_all(&id, &vec![&env, stranger]),
        Err(Ok(Error::NotStakeholder))
    );
}

#[test]
fn presence_check_does_not_apply_to_contractor() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    env.ledger().set_timestamp(PRESENCE_AT);
    assert_eq!(
        s.contract.try_confirm_presence(&id, &s.contractor, &true),
        Err(Ok(Error::NotStakeholder))
    );
}

#[test]
fn leaving_the_area_raises_alert_for_contractor() {
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
fn arbiter_marks_arrival_on_location_proof_without_paying() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);

    let reading: BytesN<32> = env.crypto().sha256(&Bytes::from_array(&env, b"41.0336,28.9771,1000,tuz")).into();
    s.contract.submit_location(&id, &s.w1, &37, &reading);
    let proof = s.contract.get_job(&id).locations.get(0).unwrap();
    assert_eq!(proof.distance_m, 37);
    assert_eq!(proof.reading_hash, reading);

    s.contract.arbiter_confirm_arrival(&id, &s.w1);
    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&s.arbiter));
    assert!(s.stake(id, 1).arrived);
    assert_eq!(s.bal(&s.w1), 0); // varış işaretlemek ödeme değildir

    // Son tarihte artık gelmiş sayılır ve payını alır
    env.ledger().set_timestamp(DEADLINE);
    s.contract.release_after_deadline(&id);
    s.finish(id);
    assert_eq!(s.bal(&s.w1), net(320_000));
}

#[test]
fn arbiter_can_release_the_share_directly() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    assert_eq!(s.contract.arbiter_release(&id, &s.w2), 180_000);
    assert_eq!(s.bal(&s.w2), net(180_000));
}

#[test]
fn deadline_pays_those_who_showed_up_and_disputes_no_shows() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);

    // w1 Kod 1'i girdi (geldi), w2 hiç gelmedi
    s.contract.check_in(&id, &s.w1, &s.code(1, CODE_ARRIVAL));

    assert_eq!(s.contract.try_release_after_deadline(&id), Err(Ok(Error::DeadlineNotReached)));
    env.ledger().set_timestamp(DEADLINE);
    s.contract.release_after_deadline(&id);
    s.finish(id);

    assert_eq!(s.bal(&s.w1), net(320_000));
    assert_eq!(s.bal(&s.w2), 0);
    assert_eq!(s.bal(&s.contractor), net(500_000));

    // w2'nin payı Trustless Work'te dispute'ta; hakem işverene iade eder
    let escrow = s.escrow(id);
    let e = escrow.get_escrow();
    assert!(e.milestones.get(2).unwrap().flags.disputed);
    let client_before = s.bal(&s.client);
    let amount = e.milestones.get(2).unwrap().amount;
    escrow.resolve_milestone_dispute(&s.arbiter, &2, &s.tw_fee, &map![&env, (s.client.clone(), amount)]);
    assert!(s.bal(&s.client) - client_before > 179_000);
    assert_eq!(s.bal(&s.contract.get_job(&id).escrow), 0);
}

#[test]
fn refund_keeps_paid_shares_with_worker() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.funded_job(1_000_000);
    s.contract.claim(&id, &s.w1, &s.code(1, CODE_FINAL));

    s.contract.refund(&id);
    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&s.client));
    assert!(signers.contains(&s.contractor));
    s.finish(id);

    assert_eq!(s.bal(&s.w1), net(320_000));
    let e = s.escrow(id).get_escrow();
    assert!(e.milestones.get(0).unwrap().flags.disputed); // ihaleci payı
    assert!(!e.milestones.get(1).unwrap().flags.disputed); // ödenmiş w1 payı
    assert!(e.milestones.get(2).unwrap().flags.disputed); // w2 payı
    assert_eq!(s.contract.get_job(&id).status, JobStatus::Refunded);
}

#[test]
fn contractor_cannot_accept_on_behalf_of_worker() {
    let env = Env::default();
    let s = setup(&env);
    let id = s.contract.create_job(&s.contractor, &s.terms(1_000_000));
    s.contract.accept_job(&id, &s.contractor);
    assert_eq!(s.contract.get_job(&id).status, JobStatus::PendingApproval);
    assert_eq!(s.contract.try_deposit(&id), Err(Ok(Error::NotAllAccepted)));
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
    t.arbiter = s.client.clone();
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidArbiter)));

    let mut t = s.terms(1_000_000);
    t.work_start = WORK_END; // bitiş başlangıçtan önce olamaz
    t.work_end = WORK_START;
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidWorkHours)));

    let mut t = s.terms(1_000_000);
    t.work_end = DEADLINE + 100; // çalışma son tarihten sonra bitemez
    assert_eq!(s.contract.try_create_job(&s.contractor, &t), Err(Ok(Error::InvalidWorkHours)));
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
    s.finish(id);
    assert_eq!(s.contract.try_continue_close(&id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(s.contract.try_complete_and_split(&id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(s.contract.try_refund(&id), Err(Ok(Error::InvalidStatus)));
    assert_eq!(
        s.contract.try_check_in(&id, &s.w2, &s.code(2, CODE_ARRIVAL)),
        Err(Ok(Error::InvalidStatus))
    );
    assert_eq!(
        s.contract.try_claim(&id, &s.w2, &s.code(2, CODE_FINAL)),
        Err(Ok(Error::InvalidStatus))
    );
}
