'use client';

import { useState, useEffect } from 'react';
import { CircleUserRoundIcon } from 'lucide-react';

import Card from '@/components/ui/card';
import { Input } from '@/components/catalyst/input';
import { Fieldset, FieldGroup, Field, Label, Legend, ErrorMessage } from '@/components/catalyst/fieldset';
import { Button } from '@/components/catalyst/button';
import { authClient } from '@/lib/auth-client';
import { useBetterAuthField } from '@/hooks/use-better-auth-field';

import ChangePasswordForm from './change-password-form';

function useNameFieldHook(fetchedName: string, showSuccessNotification: (title: string, desc?: string) => void) {
  const { fieldState: nameFieldState, createCallbacks: nameCallbacks } = useBetterAuthField();

  const [name, setName] = useState(fetchedName);
  const handleNameSave = async () =>
    await authClient.updateUser(
      { name },
      nameCallbacks(() => {
        showSuccessNotification('Name changed successfully!');
      })
    );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fetchedName) setName(fetchedName);
  }, [fetchedName]);

  return { name, setName, nameFieldState, handleNameSave };
}

type UserData = {
  fetchedName: string;
  fetchedEmail: string;
  canChangeEmail: boolean;
  canChangePassword: boolean;
  canChangeName: boolean;
};

interface ProfileInfoFormProps {
  userData: UserData;
  showSuccessNotification: (title: string, desc?: string) => void;
}

export default function ProfileInfoForm({ userData: { fetchedName, ...otherUserData }, showSuccessNotification }: ProfileInfoFormProps) {
  const { name, setName, nameFieldState, handleNameSave } = useNameFieldHook(fetchedName, showSuccessNotification);

  return (
    <>
      <Card className="my-6">
        <form onSubmit={(e) => e.preventDefault()}>
          <Fieldset>
            <Legend className="flex items-center gap-2">
              <CircleUserRoundIcon className="text-primary h-6 w-6" aria-hidden="true" />
              Profile information
            </Legend>
            <FieldGroup>
              <div className="flex items-end gap-2">
                <Field className="flex-1" disabled={!otherUserData.canChangeName}>
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    name="name"
                    autoComplete="given-name"
                    inputMode="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    invalid={!!nameFieldState.errorMessage}
                    aria-invalid={!!nameFieldState.errorMessage}
                  />
                  {nameFieldState.errorMessage && <ErrorMessage>{nameFieldState.errorMessage}</ErrorMessage>}
                </Field>
                <Button color="rose" type="button" onClick={handleNameSave} disabled={name === fetchedName || nameFieldState.isLoading}>
                  {nameFieldState.isLoading ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </FieldGroup>
          </Fieldset>
        </form>
      </Card>
      {otherUserData.canChangePassword && <ChangePasswordForm showSuccessNotification={showSuccessNotification} />}
    </>
  );
}
