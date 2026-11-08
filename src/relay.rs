//! Client for the optional Day demonstration relay. Native push works independently of this API.
use crate::{Error, Provider, Token};
use day_part_http::{Client as Http, Redirects, Request};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct Client {
    base: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Registration {
    id: String,
    credential: String,
}
impl std::fmt::Debug for Registration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registration")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}
impl Registration {
    pub fn id(&self) -> &str {
        &self.id
    }
    fn validate(&self) -> Result<(), Error> {
        if self.id.len() != 36
            || !self.id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
            || self.credential.len() != 43
            || !self
                .credential
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(Error::Platform("invalid relay registration".into()));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Environment {
    Sandbox,
    Production,
}
impl Client {
    /// HTTPS for remote servers; HTTP is accepted only for numeric loopback addresses or localhost.
    pub fn new(base: &str) -> Result<Self, Error> {
        let url = url::Url::parse(base).map_err(|e| Error::Platform(e.to_string()))?;
        let loopback = match url.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            Some(url::Host::Domain(name)) => name == "localhost",
            None => false,
        };
        if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(Error::Platform(
                "relay must be an HTTPS origin or a loopback HTTP origin".into(),
            ));
        }
        Ok(Self {
            base: url.as_str().trim_end_matches('/').into(),
        })
    }
    pub async fn enroll(
        &self,
        code: &str,
        token: &Token,
        environment: Environment,
    ) -> Result<Registration, Error> {
        let result = self
            .send(
                "/v1/devices",
                None,
                "POST",
                json!({"code":code,"provider":token.provider,
            "token":token.value,"environment":environment_for(token,environment)}),
            )
            .await?;
        let registration: Registration =
            serde_json::from_value(result).map_err(|e| Error::Platform(e.to_string()))?;
        registration.validate()?;
        Ok(registration)
    }
    pub async fn update(
        &self,
        registration: &Registration,
        token: &Token,
        environment: Environment,
    ) -> Result<(), Error> {
        registration.validate()?;
        self.send(&format!("/v1/devices/{}",registration.id),Some(&registration.credential),"PUT",
            json!({"provider":token.provider,"token":token.value,"environment":environment_for(token,environment)})).await?;
        Ok(())
    }
    /// Returns once APNs or FCM accepts the notification. Acceptance does not prove device delivery.
    pub async fn send_test(
        &self,
        registration: &Registration,
        title: &str,
        body: &str,
    ) -> Result<(), Error> {
        registration.validate()?;
        self.send(
            &format!("/v1/devices/{}/test", registration.id),
            Some(&registration.credential),
            "POST",
            json!({"title":title,"body":body,"data":{"day.demo":"push"}}),
        )
        .await?;
        Ok(())
    }
    pub async fn remove(&self, registration: &Registration) -> Result<(), Error> {
        registration.validate()?;
        self.send(
            &format!("/v1/devices/{}", registration.id),
            Some(&registration.credential),
            "DELETE",
            Value::Null,
        )
        .await?;
        Ok(())
    }
    async fn send(
        &self,
        path: &str,
        authorization: Option<&str>,
        method: &str,
        value: Value,
    ) -> Result<Value, Error> {
        let url = format!("{}{path}", self.base);
        let bytes = serde_json::to_vec(&value).map_err(|e| Error::Platform(e.to_string()))?;
        let mut request = match method {
            "POST" => Request::post(url, bytes),
            "PUT" => Request::put(url, bytes),
            _ => Request::delete(url),
        }
        .header("Content-Type", "application/json");
        if let Some(token) = authorization {
            request = request.header("Authorization", &format!("Bearer {token}"));
        }
        let response = Http::builder()
            .redirects(Redirects::Never)
            .timeout_total(std::time::Duration::from_secs(30))
            .build()
            .fetch_limited_future(request, 16 * 1024)
            .await
            .map_err(|e| Error::Platform(e.to_string()))?;
        if !(200..300).contains(&response.status) {
            // Do not echo arbitrary response bodies, which may contain tokens or proxy diagnostics.
            return Err(Error::Platform(format!(
                "relay HTTP status {}",
                response.status
            )));
        }
        serde_json::from_slice(&response.body).map_err(|e| Error::Platform(e.to_string()))
    }
}
fn environment_for(token: &Token, environment: Environment) -> Environment {
    if token.provider == Provider::Fcm {
        Environment::Production
    } else {
        environment
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relay_origins_do_not_send_credentials_over_remote_http_or_to_url_userinfo() {
        for base in [
            "http://example.test",
            "https://user@example.test",
            "https://example.test/path",
            "https://example.test?q=1",
        ] {
            assert!(Client::new(base).is_err());
        }
        for base in [
            "https://push.example.test",
            "http://127.0.0.1:8787",
            "http://[::1]:8787",
        ] {
            assert!(Client::new(base).is_ok());
        }
    }
    #[test]
    fn persisted_registration_cannot_change_the_request_path() {
        let registration = Registration {
            id: "../another-resource".into(),
            credential: "a".repeat(43),
        };
        assert!(registration.validate().is_err());
        assert!(!format!("{registration:?}").contains(&registration.credential));
    }
}
