#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env, Vec,
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
pub enum JobStatus {
    PendingApproval = 0, // İhaleci oluşturdu, çalışanların onayı bekleniyor
    Approved = 1,        // Tüm çalışanlar onayladı, müşteri fonlayabilir
    Funded = 2,          // Müşteri parayı escrow'a kilitledi
    Completed = 3,       // Para paylaştırıldı
    Refunded = 4,        // Karşılıklı iptal, para müşteriye iade edildi
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct Stakeholder {
    pub address: Address,
    pub share_bps: u32, // %100 = 10000 (örn: %32 = 3200)
    pub accepted: bool, // Çalışanın mutabakat onayı (create_job'da dışarıdan gelen değer yok sayılır)
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct Job {
    pub id: u64,
    pub client: Address,
    pub contractor: Address,
    pub token: Address,
    pub total_amount: i128,
    pub stakeholders: Vec<Stakeholder>,
    pub status: JobStatus,
    pub deadline: u64, // Bu zamandan sonra müşteri onayı olmadan da dağıtım yapılabilir (unix saniye)
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
pub struct JobPaid {
    #[topic]
    pub job_id: u64,
    pub amount: i128,
    pub by_deadline: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobRefunded {
    #[topic]
    pub job_id: u64,
    pub amount: i128,
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

/// Parayı yüzdelere göre dağıtır; yuvarlama artığı ihaleciye gider.
fn split(env: &Env, job: &mut Job) {
    job.status = JobStatus::Completed;

    let token_client = token::Client::new(env, &job.token);
    let this = env.current_contract_address();
    let mut distributed: i128 = 0;

    for s in job.stakeholders.iter() {
        let payout = job.total_amount * (s.share_bps as i128) / 10_000;
        if payout > 0 {
            token_client.transfer(&this, &s.address, &payout);
            distributed += payout;
        }
    }

    let remainder = job.total_amount - distributed;
    if remainder > 0 {
        token_client.transfer(&this, &job.contractor, &remainder);
    }
}

#[contract]
pub struct EkIslerContract;

#[contractimpl]
impl EkIslerContract {
    /// 1. İhaleci işi ve yüzdeleri oluşturur.
    /// Çalışanların `accepted` değeri her zaman false başlar; sadece ihalecinin kendi payı
    /// (imzayı zaten attığı için) onaylı sayılır.
    pub fn create_job(
        env: Env,
        client: Address,
        contractor: Address,
        token: Address,
        total_amount: i128,
        stakeholders: Vec<Stakeholder>,
        deadline: u64,
    ) -> Result<u64, Error> {
        contractor.require_auth();

        if total_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(Error::InvalidDeadline);
        }
        if stakeholders.is_empty() {
            return Err(Error::InvalidShares);
        }

        let mut total_bps: u32 = 0;
        let mut all_accepted = true;
        let mut clean: Vec<Stakeholder> = Vec::new(&env);

        for s in stakeholders.iter() {
            if s.share_bps == 0 {
                return Err(Error::InvalidShares);
            }
            total_bps = total_bps.checked_add(s.share_bps).ok_or(Error::InvalidShares)?;
            for existing in clean.iter() {
                if existing.address == s.address {
                    return Err(Error::DuplicateStakeholder);
                }
            }

            let accepted = s.address == contractor;
            if !accepted {
                all_accepted = false;
            }
            clean.push_back(Stakeholder {
                address: s.address,
                share_bps: s.share_bps,
                accepted,
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
            client,
            contractor,
            token,
            total_amount,
            stakeholders: clean,
            status: if all_accepted {
                JobStatus::Approved
            } else {
                JobStatus::PendingApproval
            },
            deadline,
        };
        save_job(&env, &job);

        Ok(job_id)
    }

    /// 2. Çalışan kendi payını cüzdan imzasıyla onaylar (mutabakat).
    pub fn accept_job(env: Env, job_id: u64, worker: Address) -> Result<(), Error> {
        worker.require_auth();

        let mut job = load_job(&env, job_id)?;
        if job.status != JobStatus::PendingApproval {
            return Err(Error::InvalidStatus);
        }

        let mut found = false;
        let mut all_accepted = true;
        let mut updated: Vec<Stakeholder> = Vec::new(&env);

        for s in job.stakeholders.iter() {
            let mut current = s;
            if current.address == worker {
                current.accepted = true;
                found = true;
            }
            if !current.accepted {
                all_accepted = false;
            }
            updated.push_back(current);
        }
        if !found {
            return Err(Error::NotStakeholder);
        }

        job.stakeholders = updated;
        if all_accepted {
            job.status = JobStatus::Approved;
        }
        save_job(&env, &job);

        JobAccepted { job_id, worker }.publish(&env);
        Ok(())
    }

    /// 3. Müşteri parayı kilitler (tüm onaylar tamamlanmış olmalı).
    pub fn deposit(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.client.require_auth();

        match job.status {
            JobStatus::Approved => {}
            JobStatus::PendingApproval => return Err(Error::NotAllAccepted),
            _ => return Err(Error::InvalidStatus),
        }

        job.status = JobStatus::Funded;
        token::Client::new(&env, &job.token).transfer(
            &job.client,
            &env.current_contract_address(),
            &job.total_amount,
        );
        save_job(&env, &job);

        JobFunded { job_id, amount: job.total_amount }.publish(&env);
        Ok(())
    }

    /// 4. Müşteri işi onaylar -> para anında bölünür.
    pub fn complete_and_split(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.client.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }

        split(&env, &mut job);
        save_job(&env, &job);

        JobPaid { job_id, amount: job.total_amount, by_deadline: false }.publish(&env);
        Ok(())
    }

    /// 5. Müşteri deadline'a kadar onay vermez / iptal etmezse herkes dağıtımı tetikleyebilir.
    /// Para sadece önceden onaylanmış adreslere gittiği için imza gerekmez.
    pub fn release_after_deadline(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }
        if env.ledger().timestamp() < job.deadline {
            return Err(Error::DeadlineNotReached);
        }

        split(&env, &mut job);
        save_job(&env, &job);

        JobPaid { job_id, amount: job.total_amount, by_deadline: true }.publish(&env);
        Ok(())
    }

    /// 6. Karşılıklı iptal: müşteri VE ihaleci birlikte imzalamalı.
    /// Tek taraflı iade, iş bittikten sonra çalışanların parasının geri çekilmesine izin verirdi.
    pub fn refund(env: Env, job_id: u64) -> Result<(), Error> {
        let mut job = load_job(&env, job_id)?;
        job.client.require_auth();
        job.contractor.require_auth();

        if job.status != JobStatus::Funded {
            return Err(Error::InvalidStatus);
        }

        job.status = JobStatus::Refunded;
        token::Client::new(&env, &job.token).transfer(
            &env.current_contract_address(),
            &job.client,
            &job.total_amount,
        );
        save_job(&env, &job);

        JobRefunded { job_id, amount: job.total_amount }.publish(&env);
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
