'use client';

import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState, type FormEvent } from 'react';
import { KeyRoundIcon } from 'lucide-react';

import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import Card from '@/components/ui/card';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { Fieldset, FieldGroup, Field, Label, Legend, Description, ErrorMessage } from '@/components/catalyst/fieldset';
import { Input } from '@/components/catalyst/input';
import { Select } from '@/components/catalyst/select';
import { Button } from '@/components/catalyst/button';
import { Divider } from '@/components/catalyst/divider';
import { Alert, AlertActions, AlertBody, AlertDescription, AlertTitle } from '@/components/catalyst/alert';

interface AiAccessFormProps {
  showSuccessNotification: (title: string, desc?: string) => void;
}

type Scope = 'read' | 'write';

/** A token just created. Its plaintext is held only in this component's state, and only until the page is left. */
interface IssuedToken {
  token: string;
  name: string;
  command: string;
}

const SCOPE_LABELS: Record<Scope, string> = {
  read: 'Read only',
  write: 'Read and write',
};

function errorText(error: unknown): string {
  return error instanceof ConvexError ? error.message : 'Something went wrong. Try again.';
}

function formatTime(time: number | undefined): string {
  return time === undefined ? 'Never' : new Date(time).toLocaleString();
}

/** The command that connects Claude Code to this deployment's MCP endpoint, with the token filled in. */
function connectCommand(token: string): string {
  return `claude mcp add --transport http ignidash ${window.location.origin}/api/mcp --header "Authorization: Bearer ${token}"`;
}

/**
 * Copies `text`, also over plain HTTP on the LAN: `navigator.clipboard` exists only in a secure
 * context (HTTPS or localhost), so `http://10.0.0.5:3030` falls back to the legacy `execCommand`.
 */
async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export default function AiAccessForm({ showSuccessNotification }: AiAccessFormProps) {
  const tokens = useQuery(api.mcp.tokens.listTokens);
  const audit = useQuery(api.mcp.tokens.listAudit, { limit: 20 });

  const createTokenMutation = useMutation(api.mcp.tokens.createToken);
  const revokeTokenMutation = useMutation(api.mcp.tokens.revokeToken);

  const [name, setName] = useState('');
  const [scope, setScope] = useState<Scope>('write');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<{ tokenId: Id<'mcpTokens'>; name: string } | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setIsCreating(true);
    setCreateError(null);
    try {
      const created = await createTokenMutation({ name, scope });
      setIssued({ token: created.token, name: name.trim(), command: connectCommand(created.token) });
      setName('');
      showSuccessNotification('Token created', 'Copy it now. It will not be shown again.');
    } catch (error) {
      setCreateError(errorText(error));
    } finally {
      setIsCreating(false);
    }
  };

  const copy = async (text: string, label: string) => {
    if (await copyText(text)) {
      setCopiedLabel(label);
      setTimeout(() => setCopiedLabel((current) => (current === label ? null : current)), 2000);
    } else {
      setCopiedLabel(null);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setIsRevoking(true);
    setRevokeError(null);
    try {
      await revokeTokenMutation({ tokenId: revokeTarget.tokenId });
      setRevokeTarget(null);
      showSuccessNotification('Token revoked', 'Clients using it can no longer reach your plans.');
    } catch (error) {
      setRevokeError(errorText(error));
    } finally {
      setIsRevoking(false);
    }
  };

  return (
    <>
      <Card className="my-6">
        <form onSubmit={handleCreate}>
          <Fieldset>
            <Legend className="flex items-center gap-2">
              <KeyRoundIcon className="text-primary h-6 w-6" aria-hidden="true" />
              AI access (MCP)
            </Legend>
            <Field>
              <Description>
                Let an AI client such as Claude Code read, and optionally change, your plans through a token you create here.
              </Description>
            </Field>

            <FieldGroup>
              <Field>
                <Label htmlFor="mcpTokenName">Token name</Label>
                <Input
                  id="mcpTokenName"
                  name="mcpTokenName"
                  type="text"
                  maxLength={60}
                  required
                  placeholder="Claude Code on my laptop"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={isCreating}
                />
              </Field>

              <Field>
                <Label htmlFor="mcpTokenScope">Access</Label>
                <Select
                  id="mcpTokenScope"
                  name="mcpTokenScope"
                  value={scope}
                  onChange={(event) => setScope(event.target.value as Scope)}
                  disabled={isCreating}
                >
                  <option value="write">{SCOPE_LABELS.write}</option>
                  <option value="read">{SCOPE_LABELS.read}</option>
                </Select>
                <Description>A read-only token cannot change anything in your plans.</Description>
              </Field>

              {createError && <ErrorMessage>{createError}</ErrorMessage>}

              <Field>
                <Button type="submit" disabled={isCreating || name.trim() === ''}>
                  {isCreating ? 'Creating...' : 'Create token'}
                </Button>
              </Field>

              {issued && (
                <>
                  <Divider />
                  <Field>
                    <Label htmlFor="mcpIssuedToken">Your new token for {issued.name}</Label>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        id="mcpIssuedToken"
                        name="mcpIssuedToken"
                        readOnly
                        value={issued.token}
                        className="font-mono text-xs sm:flex-1"
                      />
                      <Button type="button" onClick={() => copy(issued.token, 'token')}>
                        {copiedLabel === 'token' ? 'Copied' : 'Copy token'}
                      </Button>
                    </div>
                    <Description>
                      <strong className="text-red-500 dark:text-red-400">Copy it now. It will not be shown again.</strong>
                    </Description>
                  </Field>

                  <Field>
                    <Label htmlFor="mcpConnectCommand">Connect Claude Code</Label>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        id="mcpConnectCommand"
                        name="mcpConnectCommand"
                        readOnly
                        value={issued.command}
                        className="font-mono text-xs sm:flex-1"
                      />
                      <Button type="button" onClick={() => copy(issued.command, 'command')}>
                        {copiedLabel === 'command' ? 'Copied' : 'Copy command'}
                      </Button>
                    </div>
                    <Description>Run this once in a terminal on the machine where Claude Code runs.</Description>
                  </Field>
                </>
              )}
            </FieldGroup>

            <Divider className="my-6" />

            <FieldGroup>
              <Field>
                <Label>Your tokens</Label>
                {tokens === undefined && <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading tokens...</p>}
                {tokens?.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">No tokens yet.</p>}
                {tokens && tokens.length > 0 && (
                  <ul className="divide-y divide-zinc-200 dark:divide-zinc-700">
                    {tokens.map((row) => (
                      <li key={row._id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 text-sm">
                          <p className="font-medium break-words">{row.name}</p>
                          <p className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{row.prefix}…</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            {SCOPE_LABELS[row.scope]} · Created {formatTime(row.createdAt)} · Last used {formatTime(row.lastUsedAt)}
                          </p>
                        </div>
                        <div className="flex items-center gap-3 text-sm">
                          {row.revokedAt === undefined ? (
                            <Button
                              type="button"
                              color="rose"
                              onClick={() => {
                                setRevokeError(null);
                                setRevokeTarget({ tokenId: row._id, name: row.name });
                              }}
                            >
                              Revoke
                            </Button>
                          ) : (
                            <span className="text-zinc-500 dark:text-zinc-400">Revoked {formatTime(row.revokedAt)}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Field>

              <Field>
                <Label>Recent calls</Label>
                {audit === undefined && <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading calls...</p>}
                {audit?.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">No calls yet.</p>}
                {audit && audit.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-zinc-500 dark:text-zinc-400">
                        <tr>
                          <th scope="col" className="py-1 pr-3 font-medium">
                            Time
                          </th>
                          <th scope="col" className="py-1 pr-3 font-medium">
                            Token
                          </th>
                          <th scope="col" className="py-1 pr-3 font-medium">
                            Tool
                          </th>
                          <th scope="col" className="py-1 font-medium">
                            Result
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.map((row) => (
                          <tr key={row._id} className="border-t border-zinc-200 dark:border-zinc-700">
                            <td className="py-1 pr-3 whitespace-nowrap">{formatTime(row.at)}</td>
                            <td className="py-1 pr-3">{row.tokenName}</td>
                            <td className="py-1 pr-3 font-mono">{row.tool}</td>
                            <td className="py-1 break-words">{row.ok ? 'OK' : (row.error ?? 'Failed')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Field>
            </FieldGroup>
          </Fieldset>
        </form>
      </Card>

      <Alert
        open={revokeTarget !== null}
        onClose={() => {
          setRevokeTarget(null);
        }}
      >
        <AlertTitle>Revoke the token “{revokeTarget?.name}”?</AlertTitle>
        <AlertDescription>Any client using it stops working at once. This cannot be undone.</AlertDescription>
        <AlertBody>{revokeError && <ErrorMessageCard errorMessage={revokeError} />}</AlertBody>
        <AlertActions>
          <Button plain onClick={() => setRevokeTarget(null)} disabled={isRevoking}>
            Cancel
          </Button>
          <Button color="red" onClick={handleRevoke} disabled={isRevoking}>
            {isRevoking ? 'Revoking...' : 'Revoke token'}
          </Button>
        </AlertActions>
      </Alert>
    </>
  );
}
