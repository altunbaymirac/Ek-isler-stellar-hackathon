#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Bytes,
    BytesN, Env, Vec,
};

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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
pub enum JobStatus {
    PendingApproval = 0, // İhaleci oluşturdu, çalışanların onayı bekleniyor
    Approved = 1,        // Tüm çalışanlar onayladı, müşteri fonlayabilir
    Funded = 2,          // Müşteri parayı escrow'a kilitledi, dilimler açılabilir
    Completed = 3,       // Kalan para paylaştırıldı
    Refunded = 4,        // Karşılıklı iptal, ödenmemiş kısım müşteriye döndü
}

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
    pub accepted: bool, // Çalışanın mutabakat onayı
    pub paid: i128,     // Şimdiye kadar ödenen
    pub released: u32,  // Açılmış dilimlerin bit maskesi
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct LocationProof {
    pub worker: Address,
    pub lat_e6: i64,
    pub lng_e6: i64,
    pub timestamp: u64,
}

/// İhalecinin önerdiği, çalışanların imzayla kabul ettiği iş şartları.
#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct JobTerms {
    pub client: Address,
    pub arbiter: Address, // Konum anlaşmazlıklarında karar veren taraf (platform)
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
    /// Müşterinin deposit sırasında verdiği kod hash'leri: çalışan i, dilim t → [i * 3 + t]
    pub commitments: Vec<BytesN<32>>,
    pub locations: Vec<LocationProof>,
}

#[contracttype]
pub enum DataKey {
    JobCount,
    Job(u64),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobCreated {
    #[topic]
    pub job_id: u64,
    pub contractor: Address,
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
    pub lat_e6: i64,
    pub lng_e6: i64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobClosed {
    #[topic]
    pub job_id: u64,
    pub status: JobStatus,
    pub returned_to_client: i128,
}

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

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

fn share_amount(job: &Job, s: &Stakeholder) -> i128 {
    job.terms.total_amount * (s.share_bps as i128) / 10_000
}

fn tranche_bps(job: &Job, tranche: u32) -> u32 {
    match tranche {
        TRANCHE_ARRIVAL => job.terms.arrival_bps,
        TRANCHE_MID => job.terms.mid_bps,
        _ => 10_000,
    }
}

/// Çalışanın ödenen tutarını dilimin kümülatif hedefine çıkarır; aradaki farkı gönderir.
fn release_tranche(env: &Env, job: &mut Job, idx: u32, tranche: u32, by_arbiter: bool) -> Result<i128, Error> {
    if tranche >= TRANCHES {
        return Err(Error::InvalidTranche);
    }
    let mut s = job.stakeholders.get(idx).unwrap();
    if s.released & (1 << tranche) != 0 {
        return Err(Error::AlreadyReleased);
    }
    let target = share_amount(job, &s) * (tranche_bps(job, tranche) as i128) / 10_000;
    let amount = if target > s.paid { target - s.paid } else { 0 };
    if amount > 0 {
        s.paid += amount;
    }
    // Üst dilim açıldıysa alttakiler de açılmış sayılır
    s.released |= (1 << (tranche + 1)) - 1;
    job.stakeholders.set(idx, s.clone());

    if amount > 0 {
        token::Client::new(env, &job.terms.token).transfer(
            &env.current_contract_address(),
            &s.address,
            &amount,
        );
    }
    TrancheReleased { job_id: job.id, worker: s.address, tranche, amount, by_arbiter }.publish(env);
    Ok(amount)
}

/// Seçilen paydaşların kalan paylarını öder; geri kalanı ihaleciye / müşteriye yönlendirir.
fn settle(env: &Env, job: &mut Job, pay_absent: bool) -> i128 {
    let token_client = token::Client::new(env, &job.terms.token);
    let this = env.current_contract_address();
    let mut returned: i128 = 0;
    let mut updated: Vec<Stakeholder> = Vec::new(env);

    for s in job.stakeholders.iter() {
        let mut s = s;
        let owed = share_amount(job, &s) - s.paid;
        let showed_up = s.address == job.contractor || s.released & (1 << TRANCHE_ARRIVAL) != 0;
        if owed > 0 {
            if pay_absent || showed_up {
                token_client.transfer(&this, &s.address, &owed);
                s.paid += owed;
                s.released = (1 << TRANCHES) - 1;
            } else {
                returned += owed;
            }
        }
        updated.push_back(s);
    }
    job.stakeholders = updated;

    let mut paid_total: i128 = 0;
    for s in job.stakeholders.iter() {
        paid_total += s.paid;
    }
    // Yuvarlama artığı ihaleciye
    let dust = job.terms.total_amount - paid_total - returned;
    if dust > 0 {
        token_client.transfer(&this, &job.contractor, &dust);
    }
    if returned > 0 {
        token_client.transfer(&this, &job.terms.client, &returned);
    }
    returned
}

#[contract]
pub struct EkIslerContract;

#[contractimpl]
impl EkIslerContract {
    /// 1. İhaleci işi, payları, ödeme dilimlerini, etkinlik konumunu ve hakemi tanımlar.
    /// Çalışanların onayı her zaman false başlar; sadece ihalecinin kendi payı onaylı sayılır.
    pub fn create_job(env: Env, contractor: Address, terms: JobTerms) -> Result<u64, Error> {
        contractor.require_auth();

        if terms.total_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if terms.deadline <= env.ledger().timestamp() {
            return Err(Error::InvalidDeadline);
        }
        if terms.arrival_bps == 0 || terms.arrival_bps > terms.mid_bps || terms.mid_bps > 10_000 {
            return Err(Error::InvalidTranches);
        }
        if terms.shares.is_empty() {
            return Err(Error::InvalidShares);
        }
        if terms.arbiter == terms.client || terms.arbiter == contractor || terms.client == contractor {
            return Err(Error::InvalidArbiter);
        }

        let mut total_bps: u32 = 0;
        let mut all_accepted = true;
        let mut stakeholders: Vec<Stakeholder> = Vec::new(&env);

        for s in terms.shares.iter() {
            if s.share_bps == 0 {
                return Err(Error::InvalidShares);
            }
            if s.address == terms.arbiter || s.address == terms.client {
                return Err(Error::InvalidArbiter);
            }
            total_bps = total_bps.checked_add(s.share_bps).ok_or(Error::InvalidShares)?;
            for existing in stakeholders.iter() {
                if existing.address == s.address {
                    return Err(Error::DuplicateStakeholder);
                }
            }
            let accepted = s.address == contractor;
            if !accepted {
                all_accepted = false;
            }
            stakeholders.push_back(Stakeholder {
                address: s.address,
                share_bps: s.share_bps,
                accepted,
                paid: 0,
                released: 0,
            });
        }
        if total_bps != 10_000 {
            return Err(Error::InvalidShares);
        }

        let job_id: u64 = env.storage().instance().get(&DataKey::JobCount).unwrap_or(0) + 1;
        env.storage().instance().set(&DataKey::JobCount, &job_id);

        JobCreated { job_id, contractor: contractor.clone() }.publish(&env);

        let job = Job {
            id: job_id,
            contractor,
            terms,
            stakeholders,
            status: if all_accepted { JobStatus::Approved } else { JobStatus::PendingApproval },
            commitments: Vec::new(&env),
            locations: Vec::new(&env),
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

    /// 3. Müşteri parayı kilitler ve her çalışan × dilim için QR kodlarının sha256 hash'lerini verir.
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

        job.status = JobStatus::Funded;
        job.commitments = commitments;
        token::Client::new(&env, &job.terms.token).transfer(
            &job.terms.client,
            &env.current_contract_address(),
            &job.terms.total_amount,
        );
        save_job(&env, &job);

        JobFunded { job_id, amount: job.terms.total_amount }.publish(&env);
        Ok(())
    }

    /// 4. Çalışan, işverenin gösterdiği QR'daki kodu okutarak dilimi açar; para anında hesabına geçer.
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

        let amount = release_tranche(&env, &mut job, idx, tranche, false)?;
        save_job(&env, &job);
        Ok(amount)
    }

    /// Çalışan, işveren kod vermezse bulunduğu konumu kanıt olarak zincire kaydeder.
    pub fn submit_location(env: Env, job_id: u64, worker: Address, lat_e6: i64, lng_e6: i64) -> Result<(), Error> {
        worker.require_auth();

        let mut job = load_job(&env, job_id)?;
        if job.status != JobStatus::Funded && job.status != JobStatus::Approved {
            return Err(Error::InvalidStatus);
        }
        find(&job, &worker)?;
        job.locations.push_back(LocationProof {
            worker: worker.clone(),
            lat_e6,
            lng_e6,
            timestamp: env.ledger().timestamp(),
        });
        save_job(&env, &job);

        LocationSubmitted { job_id, worker, lat_e6, lng_e6 }.publish(&env);
        Ok(())
    }

    /// Hakem, konum kanıtını inceleyip (ör. işveren varış kodunu vermediyse) bir dilimi açar.
    pub fn arbiter_release(env: Env, job_id: u64, worker: Address, tranche: u32) -> Result<i128, Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.arbiter.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        let idx = find(&job, &worker)?;
        let amount = release_tranche(&env, &mut job, idx, tranche, true)?;
        save_job(&env, &job);
        Ok(amount)
    }

    /// 5. Müşteri işi onaylar: herkesin kalan payı anında ödenir.
    pub fn complete_and_split(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.client.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        job.status = JobStatus::Completed;
        let returned = settle(&env, &mut job, true);
        save_job(&env, &job);

        JobClosed { job_id, status: job.status, returned_to_client: returned }.publish(&env);
        Ok(())
    }

    /// 6. Son tarih geçti ve müşteri kapatmadı: işe gelmiş (varış dilimi açılmış) çalışanlar ve ihaleci
    /// kalan paylarını alır; hiç gelmeyenlerin payı müşteriye döner. İmza gerekmez.
    pub fn release_after_deadline(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        if env.ledger().timestamp() < job.terms.deadline {
            return Err(Error::DeadlineNotReached);
        }
        job.status = JobStatus::Completed;
        let returned = settle(&env, &mut job, false);
        save_job(&env, &job);

        JobClosed { job_id, status: job.status, returned_to_client: returned }.publish(&env);
        Ok(())
    }

    /// 7. Karşılıklı iptal (müşteri + ihaleci): ödenmemiş kısım müşteriye döner, açılmış dilimler çalışanda kalır.
    pub fn refund(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.terms.client.require_auth();
        job.contractor.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        let mut paid: i128 = 0;
        for s in job.stakeholders.iter() {
            paid += s.paid;
        }
        let returned = job.terms.total_amount - paid;
        job.status = JobStatus::Refunded;
        if returned > 0 {
            token::Client::new(&env, &job.terms.token).transfer(
                &env.current_contract_address(),
                &job.terms.client,
                &returned,
            );
        }
        save_job(&env, &job);

        JobClosed { job_id, status: job.status, returned_to_client: returned }.publish(&env);
        Ok(())
    }

    pub fn get_job(env: Env, job_id: u64) -> Result<Job, Error> {
        load_job(&env, job_id)
    }

    pub fn job_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::JobCount).unwrap_or(0)
    }
}

mod test;
