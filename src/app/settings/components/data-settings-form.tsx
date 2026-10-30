'use client';

import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { Trash2Icon } from 'lucide-react';

import Card from '@/components/ui/card';
import { Fieldset, FieldGroup, Field, Label, Legend, Description, ErrorMessage } from '@/components/catalyst/fieldset';
import { Input } from '@/components/catalyst/input';
import { Alert, AlertActions, AlertDescription, AlertTitle, AlertBody } from '@/components/catalyst/alert';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { Button } from '@/components/catalyst/button';
import { Divider } from '@/components/catalyst/divider';
import { authClient } from '@/lib/auth-client';
import { useBetterAuthField } from '@/hooks/use-better-auth-field';

interface DataSettingsFormProps {
  showSuccessNotification: (title: string, desc?: string) => void;
}

export default function DataSettingsForm({ showSuccessNotification }: DataSettingsFormProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  const [appDataAlertOpen, setAppDataAlertOpen] = useState(false);
  const [appDataDeleteError, setAppDataDeleteError] = useState<string | null>(null);

  const [accountDeletionAlertOpen, setAccountDeletionAlertOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');

  const deleteAppDataMutation = useMutation(api.app_data.deleteAppData);
  const handleDeleteApplicationData = async () => {
    await deleteAppDataMutation({ shouldCreateBlankPlan: true });
  };

  const { fieldState: deleteAccountState, createCallbacks: deleteAccountCallbacks } = useBetterAuthField();
  const handleDeleteAccount = async () => {
    await authClient.deleteUser(
      { callbackURL: '/signin?deleted=success' },
      deleteAccountCallbacks(() => showSuccessNotification('Your account and all of its data have been deleted.'))
    );
  };

  return (
    <>
      <Card className="my-6 border-red-500 dark:border-red-400">
        <form onSubmit={(e) => e.preventDefault()}>
          <Fieldset>
            <Legend className="flex items-center gap-2">
              <Trash2Icon className="text-primary h-6 w-6" aria-hidden="true" />
              Manage data
            </Legend>
            <FieldGroup>
              <Field>
                <Button
                  color="rose"
                  type="button"
                  className="w-full"
                  data-slot="control"
                  onClick={() => setAppDataAlertOpen(true)}
                  disabled={isDeleting}
                >
                  {isDeleting ? 'Deleting...' : 'Delete application data'}
                </Button>
                {appDataDeleteError && <ErrorMessage>{appDataDeleteError}</ErrorMessage>}
                <Description>
                  <strong className="text-red-500 dark:text-red-400">Warning:</strong> This action will permanently delete your app data,
                  including Simulator plans, but will not delete your account. This cannot be undone.
                </Description>
              </Field>
              <Divider />
              <Field>
                <Button
                  color="rose"
                  type="button"
                  className="w-full"
                  data-slot="control"
                  onClick={() => {
                    setDeleteConfirmation('');
                    setAccountDeletionAlertOpen(true);
                  }}
                  disabled={deleteAccountState.isLoading}
                >
                  {deleteAccountState.isLoading ? 'Deleting...' : 'Delete my account'}
                </Button>
                {deleteAccountState.errorMessage && <ErrorMessage>{deleteAccountState.errorMessage}</ErrorMessage>}
                <Description>
                  <strong className="text-red-500 dark:text-red-400">Warning:</strong> This permanently deletes your account and all of its
                  data. This cannot be undone.
                </Description>
              </Field>
            </FieldGroup>
          </Fieldset>
        </form>
      </Card>
      <Alert
        open={appDataAlertOpen}
        onClose={() => {
          setAppDataAlertOpen(false);
        }}
      >
        <AlertTitle>Are you sure you want to delete your application data?</AlertTitle>
        <AlertDescription>This action cannot be undone.</AlertDescription>
        <AlertBody>{appDataDeleteError && <ErrorMessageCard errorMessage={appDataDeleteError} />}</AlertBody>
        <AlertActions>
          <Button plain onClick={() => setAppDataAlertOpen(false)} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            color="red"
            disabled={isDeleting}
            onClick={async () => {
              setIsDeleting(true);
              setAppDataDeleteError(null);
              try {
                await handleDeleteApplicationData();
                setAppDataAlertOpen(false);
                showSuccessNotification('Application data deleted!');
              } catch (error) {
                setAppDataDeleteError(error instanceof ConvexError ? error.message : 'Failed to delete.');
                console.error('Error during deletion: ', error);
              } finally {
                setIsDeleting(false);
              }
            }}
          >
            {isDeleting ? 'Deleting...' : 'Delete now'}
          </Button>
        </AlertActions>
      </Alert>
      <Alert
        open={accountDeletionAlertOpen}
        onClose={() => {
          setAccountDeletionAlertOpen(false);
        }}
      >
        <AlertTitle>Are you sure you want to delete your account?</AlertTitle>
        <AlertDescription>This permanently deletes your account and all of its data. This cannot be undone.</AlertDescription>
        <AlertBody>
          <Field>
            <Label>Type DELETE to confirm</Label>
            <Input
              value={deleteConfirmation}
              onChange={(e) => setDeleteConfirmation(e.target.value.toUpperCase())}
              inputMode="text"
              autoComplete="off"
            />
          </Field>
        </AlertBody>
        <AlertActions>
          <Button plain onClick={() => setAccountDeletionAlertOpen(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            disabled={deleteConfirmation !== 'DELETE' || deleteAccountState.isLoading}
            onClick={async () => {
              setAccountDeletionAlertOpen(false);
              await handleDeleteAccount();
            }}
          >
            Delete account permanently
          </Button>
        </AlertActions>
      </Alert>
    </>
  );
}
