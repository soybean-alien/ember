; Ember by soybean_alien
; https://github.com/soybean-alien/ember - licensed under the GPL-3.0
; Per-user installer: copies the app (never a data folder) and adds Start menu shortcuts.
; Ember needs Node.js 22.5 or newer; setup checks for it and stops if it is missing.
; Build: ISCC.exe installer\Ember.iss  (output in installer\Output)

#define AppName "Ember"
#define AppVersion "0.1.0"

[Setup]
AppId={{8D6C3203-436D-4EFD-87BE-41AB3495F2D1}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=soybean_alien
AppPublisherURL=https://github.com/soybean-alien/ember
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
LicenseFile=..\LICENSE
OutputDir=Output
OutputBaseFilename=Ember-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}

[Files]
Source: "..\server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\Start Ember.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\Start Ember Wall.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\PLAYBOOK.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs
Source: "..\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{group}\Ember desk"; Filename: "{app}\Start Ember.cmd"; WorkingDir: "{app}"; Flags: runminimized
Name: "{group}\Ember wall"; Filename: "{app}\Start Ember Wall.cmd"; WorkingDir: "{app}"; Flags: runminimized
Name: "{group}\Uninstall Ember"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Ember"; Filename: "{app}\Start Ember.cmd"; WorkingDir: "{app}"; Flags: runminimized; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\Start Ember.cmd"; Description: "Open the Ember desk now"; Flags: postinstall nowait skipifsilent runminimized

; Uninstall removes only the files above. The data folder (listings and photos) is left in place on purpose.

[Code]
// True when "node" is on the PATH and is version 22.5 or newer (needed for the built-in SQLite).
function NodeIsReady(): Boolean;
var
  Code: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'),
    '/c node -e "const v=process.versions.node.split(/\./).map(Number);process.exit(v[0]>22||v[0]==22&&v[1]>=5?0:1)"',
    '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

function InitializeSetup(): Boolean;
begin
  Result := NodeIsReady();
  if not Result then
    SuppressibleMsgBox('Ember needs Node.js 22.5 or newer, and it was not found on this PC.' + #13#10 + #13#10 +
      'Install the current LTS from https://nodejs.org, then run this setup again.', mbCriticalError, MB_OK, IDOK);
end;
