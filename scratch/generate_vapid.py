import subprocess
import base64
import os

def b64url(b):
    return base64.urlsafe_b64encode(b).decode('utf-8').rstrip('=')

def clean_hex(s):
    # Remove all colons, spaces, newlines
    cleaned = ''.join(c for c in s if c.isalnum())
    return cleaned

def main():
    try:
        # 1. Generate EC private key
        os.makedirs('scratch', exist_ok=True)
        subprocess.run(['openssl', 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'scratch/priv.pem'], check=True)
        
        # 2. Get text output
        res = subprocess.run(['openssl', 'ec', '-in', 'scratch/priv.pem', '-text', '-noout'], capture_output=True, text=True, check=True)
        output = res.stdout
        
        # Clean up key file
        if os.path.exists('scratch/priv.pem'):
            os.remove('scratch/priv.pem')
            
        # Parse sections manually
        priv_idx = output.find('priv:')
        pub_idx = output.find('pub:')
        oid_idx = output.find('ASN1 OID:')
        
        if priv_idx == -1 or pub_idx == -1:
            print("Failed to parse OpenSSL output.")
            return
            
        priv_section = output[priv_idx + 5 : pub_idx]
        pub_section = output[pub_idx + 4 : oid_idx if oid_idx != -1 else len(output)]
        
        priv_hex = clean_hex(priv_section)
        pub_hex = clean_hex(pub_section)
        
        # If private key has a leading zero byte due to signed representation (33 bytes instead of 32), strip it
        if len(priv_hex) == 66 and priv_hex.startswith('00'):
            priv_hex = priv_hex[2:]
        # If public key has a leading zero byte (66 bytes instead of 65), strip it
        if len(pub_hex) == 132 and pub_hex.startswith('00'):
            pub_hex = pub_hex[2:]
            
        priv_bytes = bytes.fromhex(priv_hex)
        pub_bytes = bytes.fromhex(pub_hex)
        
        print("VAPID Keys generated successfully using OpenSSL:")
        print("--------------------------------------------------")
        print("Public Key (Base64url):")
        print(b64url(pub_bytes))
        print("--------------------------------------------------")
        print("Private Key (Base64url):")
        print(b64url(priv_bytes))
        print("--------------------------------------------------")
        
    except Exception as e:
        print("Error generating keys:", e)

if __name__ == '__main__':
    main()
