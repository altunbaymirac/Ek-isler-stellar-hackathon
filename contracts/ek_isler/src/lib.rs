#![no_std]
//! Ek İşler: çalışan onaylı, sahada kodla ilerleyen ödeme paylaşımı.
//!
//! Para Ek İşler kontratında değil, her iş için açılan bir **Trustless Work multi-release escrow**'unda durur.
//! Her paydaşın payı Trustless Work'te ayrı bir milestone'dur ve alıcısı paydaşın kendisidir.
//!
//! Saha adımlarının ikisi **para hareket ettirmez**, yalnızca kanıttır:
//!   * **Kod 1** (`check_in`) — ihalecinin sahada elden verdiği kod; çalışanın işe geldiğini kanıtlar.
//!   * **Kod 2** (`confirm_presence`) — ihalecinin "hâlâ burada mı?" yoklaması; gün boyunca tekrarlanabilir.
//!
//! Ödeme tek seferde, iş bitince **gün sonu kodu** (`claim`) girilince yapılır. İşveren işi hiç
//! kapatmazsa son tarihten sonra `release_after_deadline` Kod 1'i girmiş (yani gelmiş) çalışanlara öder,
//! hiç gelmeyenlerin payını Trustless Work dispute'una alır; hakem işverene iade eder.

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
    AlreadyArrived = 11,
    InvalidArbiter = 12,
    InvalidCommitments = 13,
    InvalidCode = 14,
    InvalidCodeKind = 15,
    AlreadyReleased = 16,
    TooManyMilestones = 17,
    CodesNotSet = 18,
    PresenceWindowClosed = 19,
    InvalidWorkHours = 20,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
pub enum JobStatus {
    PendingApproval = 0, // İhaleci oluşturdu, çalışanların onayı bekleniyor
    Approved = 1,        // Tüm çalışanlar onayladı, işveren escrow'u fonlayabilir
    Funded = 2,          // Trustless Work escrow'u fonlandı, saha adımları işleyebilir
    Completed = 3,       // Kalan milestone'lar serbest bırakıldı (gelmeyenler hakeme devredildi)
    Refunded = 4,        // Karşılıklı iptal: ödenmemiş milestone'lar hakeme devredildi
    Closing = 5,         // Kapanış sürüyor: milestone'lar parça parça işleniyor (continue_close)
}

/// Kapanış türü
pub const CLOSE_COMPLETE: u32 = 1; // İşveren kapattı: herkese öde
pub const CLOSE_DEADLINE: u32 = 2; // Son tarih: gelenlere öde, gelmeyenleri hakeme devret
pub const CLOSE_REFUND: u32 = 3; // Karşılıklı iptal: ödenmemişleri hakeme devret

/// Trustless Work her onayda escrow'un tamamını event olarak yayınlar; işlem başına 16 KB event
/// sınırını aşmamak için kapanışta işlem başına en fazla bu kadar milestone işlenir.
const CLOSE_BATCH: u32 = 3;

/// Kod 2 · yoklama penceresi: çalışma saatlerinin tam ortasında açılır ve bu kadar süre açık kalır.
pub const PRESENCE_WINDOW_SECS: u64 = 15 * 60;

/// Saha kodu türleri: paydaş i'nin kodu → `commitments[i * CODES + tür]`.
pub const CODE_ARRIVAL: u32 = 0; // Kod 1 · varış kanıtı, ödeme yapmaz
pub const CODE_FINAL: u32 = 1; // Gün sonu kodu · payın tamamını öder
pub const CODES: u32 = 2;

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
    pub accepted: bool, // Çalışanın mutabakat onayı
    /// Kod 1 girildi ya da hakem işaretledi. Para hareket etmez; son tarih ödemesinde
    /// "işe geldi mi" ölçütü budur.
    pub arrived: bool,
    pub checks: u32,    // Kod 2 yoklaması kaç kez yapıldı (para hareket etmez)
    pub released: bool, // Payı Trustless Work'ten ödendi
    pub disputed: bool, // Payı Trustless Work dispute'una (hakeme) devredildi
    pub paid: i128,     // Ödenen tutar (Trustless Work ücreti öncesi)
    pub milestone: u32, // Trustless Work escrow'undaki milestone indeksi
    pub amount: i128,   // Milestone tutarı
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
pub const ALERT_REPORTED_ABSENT: u32 = 1; // Kod 2: ihaleci "çalışan burada değil" dedi (çalışana bildirim)
pub const ALERT_LEFT_AREA: u32 = 2; // Konum takibi: çalışan etkinlik alanından çıktı (ihaleciye bildirim)

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
    /// Çalışma saatleri. Kod 2 yoklaması bu aralığın tam ortasında açılır.
    pub work_start: u64,
    pub work_end: u64,
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
    /// İhalecinin `set_codes` ile yazdığı kod hash'leri: paydaş i, tür k → [i * CODES + k]
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
pub struct CodesSet {
    #[topic]
    pub job_id: u64,
    pub contractor: Address,
}

/// Kod 1 girildi (ya da hakem varışı işaretledi). Para hareket etmez.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckedIn {
    #[topic]
    pub job_id: u64,
    #[topic]
    pub worker: Address,
    pub by_arbiter: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentReleased {
    #[topic]
    pub job_id: u64,
    #[topic]
    pub worker: Address,
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

/// Kod 2 · yoklama sonucu. Para hareket etmez.
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
/// Trustless Work escrow'u en fazla bu kadar milestone alır; paydaş başına bir milestone var.
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

/// Kod 2 yoklamasının açık olduğu aralık: çalışma saatlerinin ortası + PRESENCE_WINDOW_SECS.
/// İhaleciye bildirim tam `from` anında gider; `to` sonrasında yoklama yapılamaz.
pub fn presence_window(terms: &JobTerms) -> (u64, u64) {
    let mid = terms.work_start + (terms.work_end - terms.work_start) / 2;
    (mid, mid + PRESENCE_WINDOW_SECS)
}

fn require_presence_window(env: &Env, terms: &JobTerms) -> Result<u64, Error> {
    let now = env.ledger().timestamp();
    let (from, to) = presence_window(terms);
    if now < from || now >= to {
        return Err(Error::PresenceWindowClosed);
    }
    Ok(now)
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

/// Paydaşın payını Trustless Work'ten serbest bıraktırır (tek milestone, tek ödeme).
fn release_stakeholder(env: &Env, job: &mut Job, idx: u32, by_arbiter: bool) -> Result<i128, Error> {
    let mut s = job.stakeholders.get(idx).unwrap();
    if s.released || s.disputed {
        return Err(Error::AlreadyReleased);
    }
    let mut indices: Vec<u32> = Vec::new(env);
    indices.push_back(s.milestone);
    tw_release(env, &tw::Client::new(env, &job.escrow), &indices, if by_arbiter { "hakem" } else { "kod" });

    s.released = true;
    s.paid = s.amount;
    let (amount, address) = (s.amount, s.address.clone());
    job.stakeholders.set(idx, s);
    PaymentReleased { job_id: job.id, worker: address, amount, by_arbiter }.publish(env);
    Ok(amount)
}

/// İhalecinin yazdığı taahhütle girilen kodu karşılaştırır.
fn verify_code(env: &Env, job: &Job, idx: u32, kind: u32, code: &Bytes) -> Result<(), Error> {
    if kind >= CODES {
        return Err(Error::InvalidCodeKind);
    }
    if job.commitments.is_empty() {
        return Err(Error::CodesNotSet);
    }
    let expected = job.commitments.get(idx * CODES + kind).ok_or(Error::InvalidCommitments)?;
    let actual: BytesN<32> = env.crypto().sha256(code).into();
    if actual != expected {
        return Err(Error::InvalidCode);
    }
    Ok(())
}

/// Kapanışın bir parçasını işler: en fazla CLOSE_BATCH milestone'u ya serbest bırakır ya da
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
        if s.released || s.disputed {
            continue;
        }
        if picked == CLOSE_BATCH {
            remaining = true;
            break;
        }
        picked += 1;
        // Son tarih kapanışında ölçüt Kod 1'dir: gelen çalışan payını alır, gelmeyeninki hakeme gider.
        let pay = match job.close_mode {
            CLOSE_COMPLETE => true,
            CLOSE_DEADLINE => is_contractor(job, &s) || s.arrived,
            _ => false,
        };
        if pay {
            to_release.push_back(s.milestone);
            s.paid = s.amount;
            s.released = true;
        } else {
            to_dispute.push_back(s.milestone);
            s.disputed = true;
        }
        job.stakeholders.set(i, s);
    }

    tw_release(env, &escrow, &to_release, "kapanis");
    for index in to_dispute.iter() {
        escrow.dispute_milestone(&index, &me);
    }

    if !remaining {
        job.status = if job.close_mode == CLOSE_REFUND { JobStatus::Refunded } else { JobStatus::Completed };
        let mut disputed_amount: i128 = 0;
        for s in job.stakeholders.iter() {
            if s.disputed {
                disputed_amount += s.amount;
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
        let now = env.ledger().timestamp();
        if terms.deadline <= now {
            return Err(Error::InvalidDeadline);
        }
        // Çalışma saatleri Kod 2 yoklamasının zamanını belirler: bitişi geçmiş bir iş kurulamaz.
        if terms.work_start >= terms.work_end || terms.work_end <= now || terms.work_end > terms.deadline {
            return Err(Error::InvalidWorkHours);
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
            let amount = terms.total_amount * (s.share_bps as i128) / 10_000 + row_dust;
            if amount <= 0 {
                return Err(Error::InvalidAmount);
            }
            let milestone = milestones.len();
            milestones.push_back(tw::Milestone {
                description: String::from_str(&env, if contractor_row { "ihaleci" } else { "pay" }),
                status: String::from_str(&env, "-"),
                evidence: String::from_str(&env, ""),
                amount,
                flags: tw::Flags { approved: false, disputed: false, released: false, resolved: false },
                receiver: s.address.clone(),
            });
            let accepted = contractor_row;
            if !accepted {
                all_accepted = false;
            }
            stakeholders.push_back(Stakeholder {
                address: s.address,
                share_bps: s.share_bps,
                accepted,
                arrived: false,
                checks: 0,
                released: false,
                disputed: false,
                paid: 0,
                milestone,
                amount,
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

    /// 2. Çalışan payını ve şartları cüzdan imzasıyla kabul eder.
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

    /// 3. İşveren Trustless Work escrow'unu fonlar. Saha kodları işverende değil ihalecidedir.
    pub fn deposit(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.client.require_auth();

        match job.status {
            JobStatus::Approved => {}
            JobStatus::PendingApproval => return Err(Error::NotAllAccepted),
            _ => return Err(Error::InvalidStatus),
        }

        let escrow = tw::Client::new(&env, &job.escrow);
        escrow.fund_escrow(&job.terms.client, &escrow.get_escrow(), &job.terms.total_amount);

        job.status = JobStatus::Funded;
        save_job(&env, &job);

        JobFunded { job_id, amount: job.terms.total_amount }.publish(&env);
        Ok(())
    }

    /// 3b. İhaleci saha kodlarını belirler: paydaş i × tür k → `commitments[i * CODES + k] = sha256(kod)`.
    /// Kodların kendisi ihalecinin cihazında kalır; Kod 1 sahada elden verilir, gün sonu kodu iş bitince.
    /// Ödenmemiş paylar için yeniden belirlenebilir (ihaleci cihaz değiştirirse): eski kodlar geçersiz olur.
    pub fn set_codes(env: Env, job_id: u64, commitments: Vec<BytesN<32>>) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.contractor.require_auth();

        if job.status != JobStatus::Approved && job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        if commitments.len() != job.stakeholders.len() * CODES {
            return Err(Error::InvalidCommitments);
        }

        job.commitments = commitments;
        let contractor = job.contractor.clone();
        save_job(&env, &job);

        CodesSet { job_id, contractor }.publish(&env);
        Ok(())
    }

    /// 4. **Kod 1** · varış: çalışan ihalecinin elden verdiği kodu girer. **Para hareket etmez**;
    /// zincire yalnızca "bu çalışan işe geldi" kanıtı düşer. Son tarih ödemesinin ölçütü budur.
    pub fn check_in(env: Env, job_id: u64, worker: Address, code: Bytes) -> Result<(), Error> {
        worker.require_auth();

        let mut job = load_job(&env, job_id)?;
        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        let idx = find(&job, &worker)?;
        let mut s = job.stakeholders.get(idx).unwrap();
        if is_contractor(&job, &s) {
            return Err(Error::NotStakeholder);
        }
        if s.arrived {
            return Err(Error::AlreadyArrived);
        }
        verify_code(&env, &job, idx, CODE_ARRIVAL, &code)?;

        s.arrived = true;
        job.stakeholders.set(idx, s);
        save_job(&env, &job);

        CheckedIn { job_id, worker, by_arbiter: false }.publish(&env);
        Ok(())
    }

    /// 5. **Gün sonu kodu**: iş bitince ihaleci kodu verir, çalışan girer ve payının **tamamı** ödenir.
    /// Gün sonu kodu varışı da kanıtladığı için Kod 1 girilmemişse birlikte işaretlenir.
    pub fn claim(env: Env, job_id: u64, worker: Address, code: Bytes) -> Result<i128, Error> {
        worker.require_auth();

        let mut job = load_job(&env, job_id)?;
        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        let idx = find(&job, &worker)?;
        verify_code(&env, &job, idx, CODE_FINAL, &code)?;

        let mut s = job.stakeholders.get(idx).unwrap();
        if !s.arrived && !is_contractor(&job, &s) {
            s.arrived = true;
            job.stakeholders.set(idx, s);
        }
        let amount = release_stakeholder(&env, &mut job, idx, false)?;
        save_job(&env, &job);
        Ok(amount)
    }

    /// **Kod 2** · tek çalışan için yoklama. **Para hareket etmez.**
    /// Yalnızca yoklama penceresi (çalışma saatlerinin ortası + 15 dk) açıkken çağrılabilir.
    /// "Çalışıyor" → yoklama zincire yazılır. "Çalışmıyor" → uyarı düşer, çalışana bildirim gider.
    pub fn confirm_presence(env: Env, job_id: u64, worker: Address, present: bool) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.contractor.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        let now = require_presence_window(&env, &job.terms)?;
        let idx = find(&job, &worker)?;
        let mut s = job.stakeholders.get(idx).unwrap();
        if is_contractor(&job, &s) {
            return Err(Error::NotStakeholder);
        }
        if present {
            s.checks = s.checks.saturating_add(1);
            job.stakeholders.set(idx, s);
        } else {
            job.alerts.push_back(Alert { worker: worker.clone(), kind: ALERT_REPORTED_ABSENT, distance_m: 0, timestamp: now });
            AlertRaised { job_id, worker: worker.clone(), kind: ALERT_REPORTED_ABSENT, distance_m: 0 }.publish(&env);
        }
        save_job(&env, &job);
        PresenceChecked { job_id, worker, present }.publish(&env);
        Ok(())
    }

    /// **Kod 2** · toplu yoklama: ihaleciye çalışma saatlerinin ortasında giden bildirimin yanıtı.
    /// `absent` listesindeki çalışanlara "ihaleci çalışmadığını söylüyor" uyarısı düşer; listede
    /// olmayan herkes çalışıyor sayılır. **Para hareket etmez.** Tek işlemde tüm ekibi kapsar.
    pub fn confirm_presence_all(env: Env, job_id: u64, absent: Vec<Address>) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.contractor.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        let now = require_presence_window(&env, &job.terms)?;

        // Listedeki her adres bu işin çalışanı olmalı
        for a in absent.iter() {
            let idx = find(&job, &a)?;
            if is_contractor(&job, &job.stakeholders.get(idx).unwrap()) {
                return Err(Error::NotStakeholder);
            }
        }

        for i in 0..job.stakeholders.len() {
            let mut s = job.stakeholders.get(i).unwrap();
            if is_contractor(&job, &s) || s.released || s.disputed {
                continue;
            }
            let mut missing = false;
            for a in absent.iter() {
                if a == s.address {
                    missing = true;
                    break;
                }
            }
            if missing {
                job.alerts.push_back(Alert { worker: s.address.clone(), kind: ALERT_REPORTED_ABSENT, distance_m: 0, timestamp: now });
                AlertRaised { job_id, worker: s.address.clone(), kind: ALERT_REPORTED_ABSENT, distance_m: 0 }.publish(&env);
            } else {
                s.checks = s.checks.saturating_add(1);
            }
            PresenceChecked { job_id, worker: s.address.clone(), present: !missing }.publish(&env);
            job.stakeholders.set(i, s);
        }
        save_job(&env, &job);
        Ok(())
    }

    /// Çalışan, ihaleci Kod 1'i vermezse etkinliğe mesafesini ve ham ölçümün hash'ini kanıt olarak kaydeder.
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

    /// Hakem, konum kanıtına bakıp (ör. ihaleci Kod 1'i vermediyse) çalışanı **gelmiş** işaretler.
    /// Para hareket etmez; çalışan böylece son tarih ödemesine dahil olur.
    pub fn arbiter_confirm_arrival(env: Env, job_id: u64, worker: Address) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.arbiter.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        let idx = find(&job, &worker)?;
        let mut s = job.stakeholders.get(idx).unwrap();
        if is_contractor(&job, &s) {
            return Err(Error::NotStakeholder);
        }
        if s.arrived {
            return Err(Error::AlreadyArrived);
        }
        s.arrived = true;
        job.stakeholders.set(idx, s);
        save_job(&env, &job);

        CheckedIn { job_id, worker, by_arbiter: true }.publish(&env);
        Ok(())
    }

    /// Hakem, işi bitmiş sayıp çalışanın payını son tarihi beklemeden serbest bıraktırır.
    pub fn arbiter_release(env: Env, job_id: u64, worker: Address) -> Result<i128, Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.arbiter.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        let idx = find(&job, &worker)?;
        let amount = release_stakeholder(&env, &mut job, idx, true)?;
        save_job(&env, &job);
        Ok(amount)
    }

    /// 6. İşveren işi kapatır: ödenmemiş tüm paylar serbest bırakılır.
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

    /// 7. Son tarih geçti ve işveren kapatmadı: Kod 1'i girmiş (gelmiş) çalışanlar ve ihaleci payını alır;
    /// hiç gelmeyenlerin payı Trustless Work'te dispute'a alınır ve hakem işverene iade eder. İmza gerekmez.
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

    /// 8. Karşılıklı iptal (işveren + ihaleci): ödenmiş paylar çalışanda kalır, ödenmemişler
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
