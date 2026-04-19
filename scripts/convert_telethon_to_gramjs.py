#!/usr/bin/env python3
"""
Convert Telethon binary session (.session SQLite file) to GramJS string session format.

This script reads a Telethon session file and exports it as a string session
that can be uploaded to the Telegram Session Management Panel.

REQUIREMENTS:
    pip install telethon

USAGE:
    python3 convert_telethon_to_gramjs.py <path_to_session.session> <api_id> <api_hash>

EXAMPLE:
    python3 convert_telethon_to_gramjs.py my_telethon_session.session 12345678 abcdef1234567890abcdef1234567890

OUTPUT:
    Creates a file named <original_name>.gramjs.json that can be uploaded to the panel.

GETTING API CREDENTIALS:
    1. Go to https://my.telegram.org
    2. Login with your phone number
    3. Click on "API development tools"
    4. Copy your API ID and API hash
"""

import sys
import os
import json

def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    
    session_path = sys.argv[1]
    api_id = sys.argv[2]
    api_hash = sys.argv[3]
    
    if not os.path.exists(session_path):
        print(f"ERROR: File not found: {session_path}")
        sys.exit(1)
    
    print(f"Loading Telethon session: {session_path}")
    print(f"API ID: {api_id}")
    print(f"API Hash: {api_hash[:8]}...")
    
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
    except ImportError:
        print("\nERROR: Telethon is not installed.")
        print("Install it with: pip install telethon")
        sys.exit(1)
    
    # Remove .session extension for the temp name
    temp_name = session_path.replace('.session', '').replace('.bin', '')
    
    # Create a new client using the existing session file
    client = TelegramClient(temp_name, int(api_id), api_hash)
    
    try:
        # Start the client (this loads the existing session)
        client.start()
        
        # Get user info
        me = client.get_me()
        print(f"\nSession loaded successfully!")
        print(f"User: {me.first_name} {me.last_name or ''}")
        print(f"Username: @{me.username or 'N/A'}")
        print(f"Phone: {me.phone}")
        print(f"ID: {me.id}")
        
        # Export the session as a string
        # Telethon's StringSession.save() returns a string that can be used with GramJS
        string_session = client.session.save()
        
        # Create the output file
        output_data = {
            'session_string': string_session,
            'session_type': 'telethon_export',
            'user_info': {
                'id': me.id,
                'first_name': me.first_name,
                'last_name': me.last_name,
                'username': me.username,
                'phone': me.phone,
            },
        }
        
        # Save to file
        output_path = session_path.replace('.session', '.gramjs.json').replace('.bin', '.gramjs.json')
        with open(output_path, 'w') as f:
            json.dump(output_data, f, indent=2)
        
        print(f"\nConversion successful!")
        print(f"Output saved to: {output_path}")
        print(f"\nYou can now upload {output_path} to the Telegram Panel.")
        print("The panel will automatically handle the session string.")
        
    except Exception as e:
        print(f"\nERROR: Failed to convert session: {e}")
        print("\nPossible causes:")
        print("- The session file is corrupted")
        print("- The session is not logged in")
        print("- The API credentials are incorrect")
        sys.exit(1)
    finally:
        client.disconnect()

if __name__ == '__main__':
    main()
