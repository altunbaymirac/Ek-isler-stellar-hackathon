#![no_std]
//! Ek İşler: çalışan onaylı, sahada QR ile ilerleyen ödeme paylaşımı.
//!
//! Para Ek İşler kontratında değil, her iş için açılan bir **Trustless Work multi-release escrow**'unda durur.
//! Her çalışanın Varış / Mesai / Bitiş dilimi Trustless Work'te ayrı bir milestone'dur (alıcısı çalışanın kendisi).
//! Ek İşler kontratı escrow'da approver, service provider, release signer ve platform rolündedir:
//! işin kurallarını (çalışan mutabakatı, QR kod doğrulaması, hakem kararı, son tarih) uygular ve
//! koşul sağlanınca milestone'u tamamlandı işaretleyip onaylar ve Trustless Work'e serbest bıraktırır.
//! Anlaşmazlıkların (ör. hiç gelmeyen çalışan) çözümü Trustless Work'ün dispute mekanizmasında hakemdedir.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN, Env,
    String, Vec,
};

mod tw {
    soroban_sdk::contractimport!(file = "../../vendor/trustless-work/multi_release_escrow.wasm");
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    JobNotFound = 1,
    InvalidShares = 2,
    NotAllAccepted = 3,
    Unauthorized = 4,
    InvalidStatus = 5,
    InvalidAmount = 6,
    NotStakeholder = 7,
    DuplicateStakeholder = 8,
    InvalidDeadline = 9,
    DeadlineNotReached = 10,
    InvalidTranches = 11,
    InvalidArbiter = 12,
    InvalidCommitments = 13,
    InvalidCode = 14,
    InvalidTranche = 15,
    AlreadyReleased = 16,
    TooManyMilestones = 17,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
pub enum JobStatus {
    PendingApproval = 0, // İhaleci oluşturdu, çalışanların onayı bekleniyor
    Approved = 1,        // Tüm çalışanlar onayladı, işveren escrow'u fonlayabilir
    Funded = 2,          // Trustless Work escrow'u fonlandı, dilimler açılabilir
    Completed = 3,       // Kalan milestone'lar serbest bırakıldı (gelmeyenler hakeme devredildi)
    Refunded = 4,        // Karşılıklı iptal: açılmamış milestone'lar hakeme (iade için) devredildi
    Closing = 5,         // Kapanış sürüyor: milestone'lar parça parça işleniyor (continue_close)
}

/// Kapanış türü
pub const CLOSE_COMPLETE: u32 = 1; // İşveren kapattı: herkese öde
pub const CLOSE_DEADLINE: u32 = 2; // Son tarih: gelenlere öde, gelmeyenleri hakeme devret
pub const CLOSE_REFUND: u32 = 3; // Karşılıklı iptal: açılmamışları hakeme devret

/// Trustless Work her onayda escrow'un tamamını event olarak yayınlar; işlem başına 16 KB event
/// sınırını aşmamak için kapanışta işlem başına en fazla bu kadar milestone işlenir.
const CLOSE_BATCH: u32 = 3;

/// Ödeme dilimleri: çalışan her dilimi işverenin QR koduyla (ya da hakem kararıyla) açar.
pub const TRANCHE_ARRIVAL: u32 = 0; // Varış: kapora
pub const TRANCHE_MID: u32 = 1; // Mesai ortası
pub const TRANCHE_FINAL: u32 = 2; // Bitiş: payın tamamı
pub const TRANCHES: u32 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct ShareInput {
    pub address: Address,
    pub share_bps: u32, // %100 = 10000
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct Stakeholder {
    pub address: Address,
    pub share_bps: u32,
    pub accepted: bool,   // Çalışanın mutabakat onayı
    pub paid: i128,       // Serbest bırakılan milestone tutarlarının toplamı (Trustless Work ücreti öncesi)
    pub released: u32,    // Açılmış dilimlerin bit maskesi
    pub first_milestone: u32, // Trustless Work escrow'undaki ilk milestone indeksi
    pub amounts: Vec<i128>,   // Dilim (milestone) tutarları
    pub disputed: u32,        // Hakeme (Trustless Work dispute) devredilen dilimlerin bit maskesi
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
/// Konum kanıtı. Gizlilik için ham GPS koordinatı zincire yazılmaz: yalnızca etkinlik noktasına
/// mesafe ve ham ölçümün (enlem, boylam, zaman, tuz) sha256 taahhüdü tutulur. Ham ölçüm çalışanın
/// cihazında kalır; anlaşmazlıkta hakeme zincir dışında gösterilip bu hash'le doğrulanabilir.
pub struct LocationProof {
    pub worker: Address,
    pub distance_m: u32,
    pub reading_hash: BytesN<32>,
    pub timestamp: u64,
}

/// Uyarı türleri
pub const ALERT_REPORTED_ABSENT: u32 = 1; // Kod 2: işveren "çalışan burada değil" dedi (çalışana bildirim)
pub const ALERT_LEFT_AREA: u32 = 2; // Konum takibi: çalışan etkinlik alanından çıktı (işverene bildirim)

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct Alert {
    pub worker: Address,
    pub kind: u32,
    pub distance_m: u32, // alan dışı uyarısında etkinlik noktasına mesafe, diğerlerinde 0
    pub timestamp: u64,
}

/// İhalecinin önerdiği, çalışanların imzayla kabul ettiği iş şartları.
#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct JobTerms {
    pub client: Address,
    pub arbiter: Address, // Konum anlaşmazlıkları ve Trustless Work dispute çözümü
    pub token: Address,
    pub total_amount: i128,
    pub shares: Vec<ShareInput>,
    pub deadline: u64,
    pub arrival_bps: u32, // Varış kodunda ödenen, payın yüzdesi (kapora)
    pub mid_bps: u32,     // Mesai kodunda ulaşılan toplam yüzde
    pub venue_lat_e6: i64,
    pub venue_lng_e6: i64,
    pub radius_m: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct Job {
    pub id: u64,
    pub contractor: Address,
    pub terms: JobTerms,
    pub stakeholders: Vec<Stakeholder>,
    pub status: JobStatus,
    /// Bu işin Trustless Work multi-release escrow kontratı
    pub escrow: Address,
    /// İşverenin deposit sırasında verdiği kod hash'leri: paydaş i, dilim t → [i * 3 + t]
    pub commitments: Vec<BytesN<32>>,
    pub locations: Vec<LocationProof>,
    /// Kod 2 "burada değil" bildirimleri ve alan dışı çıkışlar
    pub alerts: Vec<Alert>,
    pub close_mode: u32,
}

#[contracttype]
pub enum DataKey {
    JobCount,
    Job(u64),
    TwWasm,
    TwFeeAddress,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobCreated {
    #[topic]
    pub job_id: u64,
    pub contractor: Address,
    pub escrow: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobAccepted {
    #[topic]
    pub job_id: u64,
    pub worker: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobFunded {
    #[topic]
    pub job_id: u64,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrancheReleased {
    #[topic]
    pub job_id: u64,
    #[topic]
    pub worker: Address,
    pub tranche: u32,
    pub amount: i128,
    pub by_arbiter: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocationSubmitted {
    #[topic]
    pub job_id: u64,
    #[topic]
    pub worker: Address,
    pub distance_m: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresenceChecked {
    #[topic]
    pub job_id: u64,
    #[topic]
    pub worker: Address,
    pub present: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AlertRaised {
    #[topic]
    pub job_id: u64,
    #[topic]
    pub worker: Address,
    pub kind: u32,
    pub distance_m: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobClosed {
    #[topic]
    pub job_id: u64,
    pub status: JobStatus,
    /// Hakeme (Trustless Work dispute) devredilen tutar
    pub disputed_amount: i128,
}

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
const MAX_MILESTONES: u32 = 50;

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn load_job(env: &Env, job_id: u64) -> Result<Job, Error> {
    let key = DataKey::Job(job_id);
    let job: Job = env.storage().persistent().get(&key).ok_or(Error::JobNotFound)?;
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    Ok(job)
}

fn save_job(env: &Env, job: &Job) {
    let key = DataKey::Job(job.id);
    env.storage().persistent().set(&key, job);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    bump_instance(env);
}

fn find(job: &Job, who: &Address) -> Result<u32, Error> {
    for (i, s) in job.stakeholders.iter().enumerate() {
        if s.address == *who {
            return Ok(i as u32);
        }
    }
    Err(Error::NotStakeholder)
}

fn is_contractor(job: &Job, s: &Stakeholder) -> bool {
    s.address == job.contractor
}

/// Paydaşın milestone tutarları: çalışan için [varış, mesai, bitiş], ihaleci için [payı + yuvarlama artığı].
fn tranche_amounts(env: &Env, terms: &JobTerms, share_bps: u32, contractor: bool, dust: i128) -> Vec<i128> {
    let share = terms.total_amount * (share_bps as i128) / 10_000;
    let mut v = Vec::new(env);
    if contractor {
        v.push_back(share + dust);
    } else {
        let arrival = share * (terms.arrival_bps as i128) / 10_000;
        let mid = share * (terms.mid_bps as i128) / 10_000;
        v.push_back(arrival);
        v.push_back(mid - arrival);
        v.push_back(share - mid);
    }
    v
}

fn this(env: &Env) -> Address {
    env.current_contract_address()
}

fn tw_fee(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::TwFeeAddress).unwrap()
}

/// Trustless Work escrow'unda verilen milestone'ları tek seferde tamamlandı işaretler,
/// sonra her birini onaylayıp serbest bıraktırır (para Trustless Work'ten doğrudan alıcıya gider).
fn tw_release(env: &Env, escrow: &tw::Client, indices: &Vec<u32>, evidence: &str) {
    if indices.is_empty() {
        return;
    }
    let me = this(env);
    let mut updates: Vec<tw::MilestoneUpdate> = Vec::new(env);
    for index in indices.iter() {
        updates.push_back(tw::MilestoneUpdate {
            index,
            status: String::from_str(env, "ok"),
            evidence: Some(String::from_str(env, evidence)),
        });
    }
    escrow.change_milestone_status(&updates, &me);
    let fee = tw_fee(env);
    for index in indices.iter() {
        escrow.approve_milestone(&index, &me);
        escrow.release_milestone_funds(&me, &fee, &index);
    }
}

/// Çalışanın dilimlerini `tranche`'a kadar (dahil) açar; her dilim bir Trustless Work milestone'udur.
fn release_up_to(env: &Env, job: &mut Job, idx: u32, tranche: u32, by_arbiter: bool) -> Result<i128, Error> {
    if tranche >= TRANCHES {
        return Err(Error::InvalidTranche);
    }
    let mut s = job.stakeholders.get(idx).unwrap();
    if is_contractor(job, &s) {
        return Err(Error::InvalidTranche);
    }
    if s.released & (1 << tranche) != 0 {
        return Err(Error::AlreadyReleased);
    }
    let mut indices: Vec<u32> = Vec::new(env);
    let mut amount: i128 = 0;
    for t in 0..=tranche {
        if s.released & (1 << t) == 0 {
            indices.push_back(s.first_milestone + t);
            amount += s.amounts.get(t).unwrap();
            s.released |= 1 << t;
        }
    }
    let evidence = if by_arbiter { "hakem" } else { "qr" };
    tw_release(env, &tw::Client::new(env, &job.escrow), &indices, evidence);
    s.paid += amount;
    job.stakeholders.set(idx, s.clone());
    TrancheReleased { job_id: job.id, worker: s.address, tranche, amount, by_arbiter }.publish(env);
    Ok(amount)
}

/// Kapanışın bir parçasını işler: en fazla CLOSE_BATCH açık milestone'u ya serbest bırakır ya da
/// Trustless Work'te dispute'a alır (hakem çözer, ör. işverene iade). Bittiyse işi kapatır.
fn process_close(env: &Env, job: &mut Job) {
    let escrow = tw::Client::new(env, &job.escrow);
    let me = this(env);
    let mut to_release: Vec<u32> = Vec::new(env);
    let mut to_dispute: Vec<u32> = Vec::new(env);
    let mut picked: u32 = 0;
    let mut remaining = false;

    for i in 0..job.stakeholders.len() {
        let mut s = job.stakeholders.get(i).unwrap();
        let pay = match job.close_mode {
            CLOSE_COMPLETE => true,
            CLOSE_DEADLINE => is_contractor(job, &s) || s.released & (1 << TRANCHE_ARRIVAL) != 0,
            _ => false,
        };
        let mut changed = false;
        for t in 0..s.amounts.len() {
            if (s.released | s.disputed) & (1 << t) != 0 {
                continue;
            }
            if picked == CLOSE_BATCH {
                remaining = true;
                break;
            }
            picked += 1;
            changed = true;
            if pay {
                to_release.push_back(s.first_milestone + t);
                s.paid += s.amounts.get(t).unwrap();
                s.released |= 1 << t;
            } else {
                to_dispute.push_back(s.first_milestone + t);
                s.disputed |= 1 << t;
            }
        }
        if changed {
            job.stakeholders.set(i, s);
        }
        if remaining {
            break;
        }
    }

    tw_release(env, &escrow, &to_release, "kapanis");
    for index in to_dispute.iter() {
        escrow.dispute_milestone(&index, &me);
    }

    if !remaining {
        job.status = if job.close_mode == CLOSE_REFUND { JobStatus::Refunded } else { JobStatus::Completed };
        let mut disputed_amount: i128 = 0;
        for s in job.stakeholders.iter() {
            for t in 0..s.amounts.len() {
                if s.disputed & (1 << t) != 0 {
                    disputed_amount += s.amounts.get(t).unwrap();
                }
            }
        }
        JobClosed { job_id: job.id, status: job.status, disputed_amount }.publish(env);
    }
}

fn start_close(env: &Env, job: &mut Job, mode: u32) {
    job.status = JobStatus::Closing;
    job.close_mode = mode;
    process_close(env, job);
}

#[contract]
pub struct EkIslerContract;

#[contractimpl]
impl EkIslerContract {
    /// `tw_wasm`: testnet'e yüklenmiş Trustless Work multi-release escrow wasm hash'i.
    /// `tw_fee_address`: Trustless Work testnet hattında protokol ücretinin gideceği adres (mainnet'te kontrata gömülüdür).
    pub fn __constructor(env: Env, tw_wasm: BytesN<32>, tw_fee_address: Address) {
        env.storage().instance().set(&DataKey::TwWasm, &tw_wasm);
        env.storage().instance().set(&DataKey::TwFeeAddress, &tw_fee_address);
    }

    /// 1. İhaleci işi tanımlar; kontrat bu iş için bir Trustless Work escrow'u açar.
    /// Çalışanların onayı her zaman false başlar; sadece ihalecinin kendi payı onaylı sayılır.
    pub fn create_job(env: Env, contractor: Address, terms: JobTerms) -> Result<u64, Error> {
        contractor.require_auth();

        if terms.total_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if terms.deadline <= env.ledger().timestamp() {
            return Err(Error::InvalidDeadline);
        }
        // Her dilim ayrı bir Trustless Work milestone'u olduğu için hepsi sıfırdan büyük olmalı
        if terms.arrival_bps == 0 || terms.arrival_bps >= terms.mid_bps || terms.mid_bps >= 10_000 {
            return Err(Error::InvalidTranches);
        }
        if terms.shares.is_empty() {
            return Err(Error::InvalidShares);
        }
        if terms.arbiter == terms.client || terms.arbiter == contractor || terms.client == contractor {
            return Err(Error::InvalidArbiter);
        }

        let mut total_bps: u32 = 0;
        let mut has_contractor = false;
        for s in terms.shares.iter() {
            if s.share_bps == 0 {
                return Err(Error::InvalidShares);
            }
            if s.address == terms.arbiter || s.address == terms.client {
                return Err(Error::InvalidArbiter);
            }
            if s.address == contractor {
                has_contractor = true;
            }
            total_bps = total_bps.checked_add(s.share_bps).ok_or(Error::InvalidShares)?;
        }
        if total_bps != 10_000 {
            return Err(Error::InvalidShares);
        }

        // Paylar ve Trustless Work milestone'ları
        let mut shares_sum: i128 = 0;
        for s in terms.shares.iter() {
            shares_sum += terms.total_amount * (s.share_bps as i128) / 10_000;
        }
        let dust = terms.total_amount - shares_sum;
        let job_id: u64 = env.storage().instance().get(&DataKey::JobCount).unwrap_or(0) + 1;

        let mut stakeholders: Vec<Stakeholder> = Vec::new(&env);
        let mut milestones: Vec<tw::Milestone> = Vec::new(&env);
        let mut all_accepted = true;
        for (i, s) in terms.shares.iter().enumerate() {
            for existing in stakeholders.iter() {
                if existing.address == s.address {
                    return Err(Error::DuplicateStakeholder);
                }
            }
            let contractor_row = s.address == contractor;
            // İhaleci listede yoksa yuvarlama artığı ilk paydaşa eklenir
            let row_dust = if contractor_row || (!has_contractor && i == 0) { dust } else { 0 };
            let amounts = tranche_amounts(&env, &terms, s.share_bps, contractor_row, row_dust);
            let first = milestones.len();
            for (t, amount) in amounts.clone().iter().enumerate() {
                if amount <= 0 {
                    return Err(Error::InvalidAmount);
                }
                let label = if contractor_row { "ihaleci" } else { ["varis", "mesai", "bitis"][t] };
                milestones.push_back(tw::Milestone {
                    description: String::from_str(&env, label),
                    status: String::from_str(&env, "-"),
                    evidence: String::from_str(&env, ""),
                    amount,
                    flags: tw::Flags { approved: false, disputed: false, released: false, resolved: false },
                    receiver: s.address.clone(),
                });
            }
            let accepted = contractor_row;
            if !accepted {
                all_accepted = false;
            }
            stakeholders.push_back(Stakeholder {
                address: s.address,
                share_bps: s.share_bps,
                accepted,
                paid: 0,
                released: 0,
                first_milestone: first,
                amounts,
                disputed: 0,
            });
        }
        if milestones.len() > MAX_MILESTONES {
            return Err(Error::TooManyMilestones);
        }

        // Trustless Work escrow'unu aç: kurallar bu kontratta, para Trustless Work'te
        let me = this(&env);
        let wasm: BytesN<32> = env.storage().instance().get(&DataKey::TwWasm).unwrap();
        let mut salt_src = Bytes::new(&env);
        salt_src.extend_from_array(&job_id.to_be_bytes());
        let salt: BytesN<32> = env.crypto().sha256(&salt_src).into();
        #[allow(deprecated)]
        let escrow_addr = env.deployer().with_current_contract(salt).deploy_v2(wasm, ());
        tw::Client::new(&env, &escrow_addr).initialize_escrow(&tw::Escrow {
            engagement_id: String::from_str(&env, "ekisler"),
            title: String::from_str(&env, "Ek Isler"),
            description: String::from_str(&env, ""),
            roles: tw::Roles {
                approver: me.clone(),
                service_provider: me.clone(),
                release_signer: me.clone(),
                platform: me.clone(),
                dispute_resolver: terms.arbiter.clone(),
            },
            platform_fee: 0,
            milestones,
            trustline: tw::Trustline { address: terms.token.clone() },
            receiver_memo: 0,
        });

        env.storage().instance().set(&DataKey::JobCount, &job_id);
        JobCreated { job_id, contractor: contractor.clone(), escrow: escrow_addr.clone() }.publish(&env);

        let job = Job {
            id: job_id,
            contractor,
            terms,
            stakeholders,
            status: if all_accepted { JobStatus::Approved } else { JobStatus::PendingApproval },
            escrow: escrow_addr,
            commitments: Vec::new(&env),
            locations: Vec::new(&env),
            alerts: Vec::new(&env),
            close_mode: 0,
        };
        save_job(&env, &job);
        Ok(job_id)
    }

    /// 2. Çalışan payını, dilim oranlarını ve hakemi cüzdan imzasıyla kabul eder.
    pub fn accept_job(env: Env, job_id: u64, worker: Address) -> Result<(), Error> {
        worker.require_auth();

        let mut job = load_job(&env, job_id)?;
        if job.status != JobStatus::PendingApproval {
            return Err(Error::InvalidStatus);
        }
        let idx = find(&job, &worker)?;
        let mut s = job.stakeholders.get(idx).unwrap();
        s.accepted = true;
        job.stakeholders.set(idx, s);

        if job.stakeholders.iter().all(|s| s.accepted) {
            job.status = JobStatus::Approved;
        }
        save_job(&env, &job);

        JobAccepted { job_id, worker }.publish(&env);
        Ok(())
    }

    /// 3. İşveren Trustless Work escrow'unu fonlar ve her paydaş × dilim için QR kodlarının sha256 hash'lerini verir.
    pub fn deposit(env: Env, job_id: u64, commitments: Vec<BytesN<32>>) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.client.require_auth();

        match job.status {
            JobStatus::Approved => {}
            JobStatus::PendingApproval => return Err(Error::NotAllAccepted),
            _ => return Err(Error::InvalidStatus),
        }
        if commitments.len() != job.stakeholders.len() * TRANCHES {
            return Err(Error::InvalidCommitments);
        }

        let escrow = tw::Client::new(&env, &job.escrow);
        escrow.fund_escrow(&job.terms.client, &escrow.get_escrow(), &job.terms.total_amount);

        job.status = JobStatus::Funded;
        job.commitments = commitments;
        save_job(&env, &job);

        JobFunded { job_id, amount: job.terms.total_amount }.publish(&env);
        Ok(())
    }

    /// 4. Çalışan, işverenin gösterdiği QR'daki kodu okutarak dilimi açar; Trustless Work milestone'u anında ödenir.
    pub fn claim(env: Env, job_id: u64, worker: Address, tranche: u32, code: Bytes) -> Result<i128, Error> {
        worker.require_auth();

        let mut job = load_job(&env, job_id)?;
        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        if tranche >= TRANCHES {
            return Err(Error::InvalidTranche);
        }
        let idx = find(&job, &worker)?;
        let expected = job.commitments.get(idx * TRANCHES + tranche).ok_or(Error::InvalidCommitments)?;
        let actual: BytesN<32> = env.crypto().sha256(&code).into();
        if actual != expected {
            return Err(Error::InvalidCode);
        }

        let amount = release_up_to(&env, &mut job, idx, tranche, false)?;
        save_job(&env, &job);
        Ok(amount)
    }

    /// Çalışan, işveren kod vermezse etkinlik noktasına mesafesini ve ham ölçümün hash'ini kanıt olarak kaydeder.
    pub fn submit_location(
        env: Env,
        job_id: u64,
        worker: Address,
        distance_m: u32,
        reading_hash: BytesN<32>,
    ) -> Result<(), Error> {
        worker.require_auth();

        let mut job = load_job(&env, job_id)?;
        if job.status != JobStatus::Funded && job.status != JobStatus::Approved {
            return Err(Error::InvalidStatus);
        }
        find(&job, &worker)?;
        let now = env.ledger().timestamp();
        job.locations.push_back(LocationProof {
            worker: worker.clone(),
            distance_m,
            reading_hash,
            timestamp: now,
        });
        if distance_m > job.terms.radius_m {
            job.alerts.push_back(Alert { worker: worker.clone(), kind: ALERT_LEFT_AREA, distance_m, timestamp: now });
            AlertRaised { job_id, worker: worker.clone(), kind: ALERT_LEFT_AREA, distance_m }.publish(&env);
        }
        save_job(&env, &job);

        LocationSubmitted { job_id, worker, distance_m }.publish(&env);
        Ok(())
    }

    /// Kod 2 · devam kontrolü: işveren çalışanın hâlâ iş yerinde olup olmadığını onaylar.
    /// "Burada" → mesai dilimi (gerekirse kapora da) Trustless Work'ten anında ödenir.
    /// "Burada değil" → zincire uyarı düşer, çalışana bildirim gider; para hareket etmez.
    pub fn confirm_presence(env: Env, job_id: u64, worker: Address, present: bool) -> Result<i128, Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.client.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        let idx = find(&job, &worker)?;
        let amount = if present {
            release_up_to(&env, &mut job, idx, TRANCHE_MID, false)?
        } else {
            let now = env.ledger().timestamp();
            job.alerts.push_back(Alert { worker: worker.clone(), kind: ALERT_REPORTED_ABSENT, distance_m: 0, timestamp: now });
            AlertRaised { job_id, worker: worker.clone(), kind: ALERT_REPORTED_ABSENT, distance_m: 0 }.publish(&env);
            0
        };
        save_job(&env, &job);
        PresenceChecked { job_id, worker, present }.publish(&env);
        Ok(amount)
    }

    /// Hakem, konum kanıtını inceleyip (ör. işveren varış kodunu vermediyse) bir dilimi açar.
    pub fn arbiter_release(env: Env, job_id: u64, worker: Address, tranche: u32) -> Result<i128, Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.arbiter.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        let idx = find(&job, &worker)?;
        let amount = release_up_to(&env, &mut job, idx, tranche, true)?;
        save_job(&env, &job);
        Ok(amount)
    }

    /// 5. İşveren işi kapatır: tüm açılmamış milestone'lar serbest bırakılır.
    pub fn complete_and_split(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.client.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        start_close(&env, &mut job, CLOSE_COMPLETE);
        save_job(&env, &job);
        Ok(())
    }

    /// 6. Son tarih geçti ve işveren kapatmadı: işe gelmiş (varış dilimi açılmış) çalışanlar ve ihaleci
    /// kalanlarını alır; hiç gelmeyenlerin milestone'ları Trustless Work'te dispute'a alınır ve
    /// hakem bunları işverene iade eder. İmza gerekmez.
    pub fn release_after_deadline(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        if env.ledger().timestamp() < job.terms.deadline {
            return Err(Error::DeadlineNotReached);
        }
        start_close(&env, &mut job, CLOSE_DEADLINE);
        save_job(&env, &job);
        Ok(())
    }

    /// 7. Karşılıklı iptal (işveren + ihaleci): açılmış dilimler çalışanda kalır, açılmamış milestone'lar
    /// Trustless Work'te dispute'a alınır; hakem bunları işverene iade eder.
    pub fn refund(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.client.require_auth();
        job.contractor.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        start_close(&env, &mut job, CLOSE_REFUND);
        save_job(&env, &job);
        Ok(())
    }

    /// Kapanış birden fazla işleme bölündüyse kalan milestone'ları işler. İmza gerekmez:
    /// kapanış türü ve alıcılar zaten belirlidir.
    pub fn continue_close(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        if job.status != JobStatus::Closing {
            return Err(Error::InvalidStatus);
        }
        process_close(&env, &mut job);
        save_job(&env, &job);
        Ok(())
    }

    pub fn get_job(env: Env, job_id: u64) -> Result<Job, Error> {
        load_job(&env, job_id)
    }

    pub fn job_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::JobCount).unwrap_or(0)
    }

    pub fn tw_config(env: Env) -> (BytesN<32>, Address) {
        (
            env.storage().instance().get(&DataKey::TwWasm).unwrap(),
            env.storage().instance().get(&DataKey::TwFeeAddress).unwrap(),
        )
    }
}

mod test;
