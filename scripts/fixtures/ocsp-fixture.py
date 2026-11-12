"""Issue a one-day test chain and a signed GOOD OCSP response. Requires cryptography."""
import base64
import datetime
import json
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization as s
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509 import ocsp
from cryptography.x509.oid import AuthorityInformationAccessOID, NameOID

now = datetime.datetime.now(datetime.timezone.utc)
issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Orders Test CA")])
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "order.example.test")])
ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def certificate(subject, key):
    return (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=1)))


ca = certificate(issuer, ca_key).add_extension(x509.BasicConstraints(ca=True, path_length=0), True).sign(ca_key, hashes.SHA256())
leaf = (certificate(name, leaf_key)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("order.example.test")]), False)
        .add_extension(x509.AuthorityInformationAccess([x509.AccessDescription(AuthorityInformationAccessOID.OCSP, x509.UniformResourceIdentifier(sys.argv[1]))]), False)
        .sign(ca_key, hashes.SHA256()))
response = (ocsp.OCSPResponseBuilder().add_response(leaf, ca, hashes.SHA1(), ocsp.OCSPCertStatus.GOOD,
            now - datetime.timedelta(minutes=1), now + datetime.timedelta(hours=1), None, None)
            .responder_id(ocsp.OCSPResponderEncoding.HASH, ca).sign(ca_key, hashes.SHA256()))
print(json.dumps(dict(ca=ca.public_bytes(s.Encoding.PEM).decode(), leaf=leaf.public_bytes(s.Encoding.PEM).decode(),
                      key=leaf_key.private_bytes(s.Encoding.PEM, s.PrivateFormat.PKCS8, s.NoEncryption()).decode(),
                      response=base64.b64encode(response.public_bytes(s.Encoding.DER)).decode())))
